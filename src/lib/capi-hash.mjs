import { createHash } from "node:crypto";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** UAE-aware phone digits, the single normalization used by every Meta path. */
export function normalizedPhone(phone) {
  let digits = String(phone).replace(/\D/g, "");
  // 00971... (international dialling prefix) is 971...
  if (/^00\d{10,}$/.test(digits)) digits = digits.slice(2);
  // +971 0501234567: people keep the local leading 0 after the country code; Meta wants it dropped.
  if (/^9710\d{9}$/.test(digits)) return `971${digits.slice(4)}`;
  if (/^0\d{9}$/.test(digits)) return `971${digits.slice(1)}`;
  if (/^\d{9}$/.test(digits)) return `971${digits}`;
  return digits;
}

/** Hashed matching keys. Only plausible phones/addresses are sent, never the clear value. */
export function hashedContactKeys(contact = {}) {
  const out = {};
  const phone = contact.phone ? normalizedPhone(contact.phone) : "";
  if (/^\d{8,15}$/.test(phone)) out.ph = [sha256(phone)];
  const email = typeof contact.email === "string" ? contact.email.trim().toLowerCase() : "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.em = [sha256(email)];
  return out;
}

/** Deterministic UUID (v5 style) so an outbox row for one lead and event kind can be inserted only once. */
export function deterministicUuid(text) {
  const b = createHash("sha1").update(`newme-capi-outbox:${text}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
