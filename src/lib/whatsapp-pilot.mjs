import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const digits = (value) => typeof value === "string" && /^\+?\d{7,15}$/.test(value) ? value.replace(/^\+/, "") : null;

export function verifyWhatsAppSignature(bytes, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature ?? "")) return false;
  const expected = createHmac("sha256", secret).update(bytes).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

/** Store event metadata only. Never retain webhook bodies, chat text or media URLs. */
export function extractWhatsAppEvents(payload, channels, contactSalt, now = Date.now()) {
  if (!contactSalt || payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) {
    throw new Error("invalid_whatsapp_payload");
  }
  const configured = new Map(channels.filter((c) => c.enabled).map((c) => [c.phone_number_id, c]));
  const events = new Map();
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (!["messages", "smb_message_echoes"].includes(change?.field)) continue;
      const value = change.value;
      const channel = configured.get(value?.metadata?.phone_number_id);
      if (!channel || entry.id !== channel.waba_id || value.messaging_product !== "whatsapp") continue;
      const phone = digits(channel.business_phone);
      const display = typeof value.metadata.display_phone_number === "string" ? value.metadata.display_phone_number.replace(/[ ()+.-]/g, "") : null;
      if (!phone || digits(display) !== phone) continue;
      const inbound = change.field === "messages";
      const messages = inbound ? value.messages : value.message_echoes;
      for (const message of Array.isArray(messages) ? messages : []) {
        const customer = digits(inbound ? message?.from : message?.to);
        const time = Number(message?.timestamp) * 1000;
        if (!customer || customer === phone || !message?.id || typeof message.id !== "string" || message.id.length > 256) continue;
        if (typeof message.type !== "string" || !/^[a-z_]{1,40}$/.test(message.type)) continue;
        // Unsupported events and group/call traffic are not evidence of a reply.
        if (["unsupported", "unknown", "system", "call"].includes(message.type) || message.errors) continue;
        if (!inbound && digits(message.from) !== phone) continue;
        const acceptSince = Date.parse(channel.accept_since);
        if (!Number.isFinite(time) || !Number.isFinite(acceptSince) || time < acceptSince || time > now + 300_000) continue;
        const customerKey = createHmac("sha256", contactSalt).update(customer).digest("hex");
        const event = {
          channel_id: channel.id,
          message_id: message.id,
          customer_key: customerKey,
          direction: inbound ? "inbound" : "outbound",
          source: change.field,
          message_type: message.type,
          occurred_at: new Date(time).toISOString(),
        };
        events.set(`${channel.id}:${message.id}`, event);
      }
    }
  }
  return [...events.values()];
}

/** Event time, not delivery order, drives observed response bursts. */
export function summarizeWhatsAppEvents(events) {
  const grouped = new Map();
  const seen = new Set();
  // Meta timestamps have second precision. A send in the same second cannot
  // establish that it followed an incoming message: process sends first.
  for (const event of [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || (a.direction === b.direction ? a.message_id.localeCompare(b.message_id) : a.direction === "outbound" ? -1 : 1))) {
    const dedup = `${event.channel_id}:${event.message_id}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    const key = `${event.channel_id}:${event.customer_key}`;
    const row = grouped.get(key) ?? {
      channel_id: event.channel_id, customer_ref: event.customer_key.slice(0, 12),
      inbound_count: 0, outbound_count: 0, pending_since: null,
      last_inbound_at: null, last_outbound_at: null, observed_response_seconds: [],
    };
    if (event.direction === "inbound") {
      row.inbound_count++;
      row.last_inbound_at = event.occurred_at;
      row.pending_since ??= event.occurred_at;
    } else {
      row.outbound_count++;
      row.last_outbound_at = event.occurred_at;
      if (row.pending_since) {
        row.observed_response_seconds.push(Math.max(0, (Date.parse(event.occurred_at) - Date.parse(row.pending_since)) / 1000));
        row.pending_since = null;
      }
    }
    grouped.set(key, row);
  }
  return [...grouped.values()];
}
