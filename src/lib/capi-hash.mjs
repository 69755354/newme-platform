import { createHash } from "node:crypto";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** UAE-aware phone digits, the single normalization used by every Meta path. */
export function normalizedPhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
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
