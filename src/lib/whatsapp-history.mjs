// One-time coexistence sync (OS fix S25): chat history (`history` webhook field) and phone contacts
// (`smb_app_state_sync`). Pure parsing plus a small writer; the route calls both.
//
// Rules this module guarantees:
//  - History is stored as backfilled events only. It never goes through record_whatsapp_ad_event, so it cannot
//    create leads, queue Meta feedback, carry click ids, or move first-response timing.
//  - Only approved, enabled channels are read (same checks as the live parser). No accept_since or 30-day
//    freshness limit applies (Meta sends up to 180 days), but a time must be sane: not in the future and
//    not older than MAX_HISTORY_AGE_DAYS.
//  - Text bodies are kept exactly like S21 (text only, 4096 characters); media and other kinds keep a marker.
import { messageBody, messageBodyKind, normalizeWhatsAppPhoneKey } from "./whatsapp-ctwa.mjs";

export const MAX_HISTORY_WEBHOOK_BYTES = 3 * 1024 * 1024;
export const MAX_HISTORY_AGE_DAYS = 200;
export const HISTORY_BATCH = 200;
const digitsOf = (value) => typeof value === "string" && /^\+?\d{7,15}$/.test(value) ? value.replace(/^\+/, "") : null;
const clip = (value, max) => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
};
const SKIP_TYPES = new Set(["unsupported", "unknown", "system", "call"]);

export function historySyncEnabled(env = process.env) {
  return env.WHATSAPP_HISTORY_SYNC_ENABLED !== "false";
}

/** True when the body carries at least one history or smb_app_state_sync change (cheap pre-check, no channel check). */
export function hasHistorySyncFields(payload) {
  return Array.isArray(payload?.entry) && payload.entry.some((entry) =>
    Array.isArray(entry?.changes) && entry.changes.some((c) => c?.field === "history" || c?.field === "smb_app_state_sync"));
}

function approvedChannel(entry, value, configured) {
  const channel = configured.get(value?.metadata?.phone_number_id);
  if (!channel || entry.id !== channel.waba_id || value.messaging_product !== "whatsapp") return null;
  const business = digitsOf(channel.business_phone);
  const display = typeof value.metadata.display_phone_number === "string" ? value.metadata.display_phone_number.replace(/[ ()+.-]/g, "") : null;
  if (!business || digitsOf(display) !== business) return null;
  return { channel, business };
}

/**
 * Read history messages and synced contacts from a verified webhook body.
 * Returns { messages, contacts, chunks, declined }:
 *  messages: { waba_id, phone_number_id, customer_phone, direction, message_id, message_type, body, body_kind, occurred_at }
 *  contacts: { waba_id, phone_number_id, phone, full_name, first_name, action }
 *  chunks:   [{ phase, chunk_order, progress }] as reported by Meta (for logs only)
 *  declined: count of history entries that carry errors (for example the customer declined the sync)
 */
export function extractWhatsAppHistory(payload, channels, now = Date.now()) {
  const out = { messages: [], contacts: [], chunks: [], declined: 0 };
  if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return out;
  const configured = new Map(channels.filter((c) => c.enabled).map((c) => [c.phone_number_id, c]));
  const seen = new Set();
  const oldest = now - MAX_HISTORY_AGE_DAYS * 86_400_000;
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "history" && change?.field !== "smb_app_state_sync") continue;
      const value = change.value;
      const ok = approvedChannel(entry, value, configured);
      if (!ok) continue;
      const { channel, business } = ok;
      if (change.field === "history") {
        for (const chunk of Array.isArray(value.history) ? value.history : []) {
          if (Array.isArray(chunk?.errors) && chunk.errors.length) out.declined += 1;
          const meta = chunk?.metadata;
          if (meta && typeof meta === "object") {
            out.chunks.push({ phase: Number.isFinite(Number(meta.phase)) ? Number(meta.phase) : null,
              chunk_order: Number.isFinite(Number(meta.chunk_order)) ? Number(meta.chunk_order) : null,
              progress: Number.isFinite(Number(meta.progress)) ? Number(meta.progress) : null });
          }
          for (const thread of Array.isArray(chunk?.threads) ? chunk.threads : []) {
            const threadCustomer = digitsOf(thread?.id);
            for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
              if (typeof message?.id !== "string" || !message.id || message.id.length > 256) continue;
              if (typeof message.type !== "string" || !/^[a-z_]{1,40}$/.test(message.type) || SKIP_TYPES.has(message.type) || message.errors) continue;
              const from = digitsOf(message.from);
              if (!from) continue;
              const outbound = from === business;
              const customer = outbound ? (threadCustomer ?? digitsOf(message.to)) : from;
              const time = Number(message.timestamp) * 1000;
              if (!customer || customer === business || !Number.isSafeInteger(time) || time < oldest || time > now + 300_000) continue;
              const key = `${channel.waba_id}:${message.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              out.messages.push({
                waba_id: channel.waba_id, phone_number_id: channel.phone_number_id, customer_phone: customer,
                direction: outbound ? "outbound" : "inbound", message_id: message.id, message_type: message.type,
                body: messageBody(message), body_kind: messageBodyKind(message.type), occurred_at: new Date(time).toISOString(),
              });
            }
          }
        }
      } else {
        for (const item of Array.isArray(value.state_sync) ? value.state_sync : []) {
          if (item?.type !== "contact") continue;
          const phone = normalizeWhatsAppPhoneKey(item?.contact?.phone_number);
          if (!phone) continue;
          out.contacts.push({
            waba_id: channel.waba_id, phone_number_id: channel.phone_number_id, phone,
            full_name: clip(item.contact?.full_name, 200), first_name: clip(item.contact?.first_name, 200),
            action: item.action === "remove" ? "remove" : "add",
          });
        }
      }
    }
  }
  return out;
}

/**
 * Write parsed history through the two history-only routines. Idempotent; a failed batch is counted and the
 * caller answers 503 so Meta retries the whole delivery (already stored messages are skipped by the database).
 */
export async function recordWhatsAppHistory(db, { messages, contacts }) {
  const summary = { messages: messages.length, inserted: 0, duplicate: 0, rejected: 0, contacts: contacts.length, contacts_upserted: 0, contacts_removed: 0, failed: 0 };
  for (let i = 0; i < messages.length; i += HISTORY_BATCH) {
    try {
      const { data, error } = await db.rpc("record_whatsapp_history_messages", { p_events: messages.slice(i, i + HISTORY_BATCH) });
      if (error) throw new Error("rpc_failed");
      summary.inserted += Number(data?.inserted ?? 0);
      summary.duplicate += Number(data?.duplicate ?? 0);
      summary.rejected += Number(data?.rejected ?? 0);
    } catch { summary.failed++; }
  }
  for (let i = 0; i < contacts.length; i += HISTORY_BATCH) {
    try {
      const { data, error } = await db.rpc("record_whatsapp_synced_contacts", { p_contacts: contacts.slice(i, i + HISTORY_BATCH) });
      if (error) throw new Error("rpc_failed");
      summary.contacts_upserted += Number(data?.upserted ?? 0);
      summary.contacts_removed += Number(data?.removed ?? 0);
      summary.rejected += Number(data?.rejected ?? 0);
    } catch { summary.failed++; }
  }
  return summary;
}
