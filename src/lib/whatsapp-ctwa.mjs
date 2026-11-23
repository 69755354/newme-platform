import { phoneIdentityKey } from "./lead-contact.mjs";
// Click-to-WhatsApp (CTWA) ad attribution parsing. Pure functions shared by the
// webhook route, the sender and node:test.
//
// What is kept: the customer's phone number (needed to match or create the lead, exactly as the
// CRM already stores it), the ad referral ids and, since S21, the text of text messages (`body`).
// Media, reactions and other message kinds keep only a kind marker (`body_kind`). Ad body text,
// captions and media links are never copied out of the webhook body.
import { isWhatsAppEventFresh } from "./whatsapp-pilot.mjs";

const CTWA_CLID = /^[A-Za-z0-9_-]{10,512}$/;
const NUMERIC_ID = /^[0-9]{5,32}$/;
const digitsOf = (value) => typeof value === "string" && /^\+?\d{7,15}$/.test(value) ? value.replace(/^\+/, "") : null;
const clip = (value, max) => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
};

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker", "location", "contacts"]);
export const MAX_MESSAGE_BODY = 4096;

/** The text of a text message, control characters removed (line breaks and tabs kept), at most 4096 characters. */
export function messageBody(message) {
  if (message?.type !== "text" || typeof message?.text?.body !== "string") return null;
  const text = message.text.body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, MAX_MESSAGE_BODY) : null;
}

/** text = body kept, media = marker only, other = marker only (reactions, buttons, orders and so on). */
export function messageBodyKind(type) {
  return type === "text" ? "text" : MEDIA_TYPES.has(type) ? "media" : "other";
}

/** Meta's click id is a url-safe token; anything else is treated as absent. */
export function normalizeCtwaClid(raw) {
  return typeof raw === "string" && CTWA_CLID.test(raw) ? raw : null;
}

/**
 * One key per UAE-or-international number, mirroring public.wa_phone_key() in the
 * database: digits only, "00" prefix dropped, local UAE spellings given 971, a
 * stray trunk 0 after 971 removed. Null when the input is not a plausible number.
 */
export function normalizeWhatsAppPhoneKey(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  // S39: the shared reader first (one phone normalizer for every entry point); the lenient digits rule below is kept for
  // numbers the shared reader refuses, so the key stays equal to public.wa_phone_key().
  const shared = phoneIdentityKey(raw);
  if (shared) return shared;
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("9710") && d.length === 13) d = `971${d.slice(4)}`;
  else if (d.startsWith("0") && d.length >= 9 && d.length <= 10) d = `971${d.slice(1)}`;
  else if (d.length === 9 && d.startsWith("5")) d = `971${d}`;
  return d.length >= 7 && d.length <= 15 ? d : null;
}

function cleanReferral(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const sourceType = typeof raw.source_type === "string" && /^[a-z_]{1,20}$/.test(raw.source_type) ? raw.source_type : null;
  const sourceId = typeof raw.source_id === "string" && NUMERIC_ID.test(raw.source_id) ? raw.source_id : null;
  const url = clip(raw.source_url, 500);
  return {
    source_type: sourceType,
    // Only an ad id is an ad id; a post id is kept apart so it never lands in leads.ad_id.
    source_id: sourceId,
    source_url: url && /^https:\/\/[^\s]+$/i.test(url) ? url : null,
    headline: clip(raw.headline, 200),
    ctwa_clid: normalizeCtwaClid(raw.ctwa_clid),
  };
}

/**
 * Read every approved-channel message from a verified webhook body.
 * Fields: waba_id, phone_number_id, channel_id, customer_phone (digits), direction,
 * source, message_id, message_type, body, body_kind, occurred_at, profile_name, referral.
 */
export function extractWhatsAppAdEvents(payload, channels, now = Date.now()) {
  if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) throw new Error("invalid_whatsapp_payload");
  const configured = new Map(channels.filter((c) => c.enabled).map((c) => [c.phone_number_id, c]));
  const events = new Map();
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (!["messages", "smb_message_echoes"].includes(change?.field)) continue;
      const value = change.value;
      const channel = configured.get(value?.metadata?.phone_number_id);
      if (!channel || entry.id !== channel.waba_id || value.messaging_product !== "whatsapp") continue;
      const business = digitsOf(channel.business_phone);
      const display = typeof value.metadata.display_phone_number === "string" ? value.metadata.display_phone_number.replace(/[ ()+.-]/g, "") : null;
      if (!business || digitsOf(display) !== business) continue;
      const inbound = change.field === "messages";
      const messages = inbound ? value.messages : value.message_echoes;
      const names = new Map();
      for (const contact of Array.isArray(value.contacts) ? value.contacts : []) {
        const id = digitsOf(contact?.wa_id);
        const name = clip(contact?.profile?.name, 200);
        if (id && name) names.set(id, name);
      }
      const acceptSince = Date.parse(channel.accept_since);
      for (const message of Array.isArray(messages) ? messages : []) {
        const customer = digitsOf(inbound ? message?.from : message?.to);
        const time = Number(message?.timestamp) * 1000;
        if (!customer || customer === business || typeof message?.id !== "string" || !message.id || message.id.length > 256) continue;
        if (typeof message.type !== "string" || !/^[a-z_]{1,40}$/.test(message.type)) continue;
        if (["unsupported", "unknown", "system", "call"].includes(message.type) || message.errors) continue;
        if (!inbound && digitsOf(message.from) !== business) continue;
        if (!isWhatsAppEventFresh(time, now) || !Number.isFinite(acceptSince) || time < acceptSince) continue;
        const key = `${channel.waba_id}:${message.id}`;
        const previous = events.get(key);
        const referral = inbound ? cleanReferral(message.referral) : null;
        // A replay of the same message keeps the first copy's click id.
        if (previous && (previous.referral || !referral)) continue;
        events.set(key, {
          waba_id: channel.waba_id,
          phone_number_id: channel.phone_number_id,
          channel_id: channel.id,
          customer_phone: customer,
          direction: inbound ? "inbound" : "outbound",
          source: change.field,
          message_id: message.id,
          message_type: message.type,
          body: messageBody(message),
          body_kind: messageBodyKind(message.type),
          occurred_at: new Date(time).toISOString(),
          profile_name: inbound ? names.get(customer) ?? null : null,
          referral,
        });
      }
    }
  }
  return [...events.values()];
}
