// S41 (recheck §2-1, F12/OA9): one search matcher for the leads board and the mobile list. A phone typed in any
// format (+971 50 123 4567, 050-123-4567, 00971501234567, a suffix) finds the lead whatever format it was stored in;
// names, locations and assignee ids keep their case-insensitive substring match.
import { waPhoneKey } from "./lead-contact.mjs";

const MIN_PHONE_DIGITS = 4;

/** Digit strings a search term can stand for: as typed, without leading zeros, and its wa_phone_key form. */
export function searchDigitCandidates(search) {
  const digits = String(search ?? "").replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return [];
  const out = [digits];
  const stripped = digits.replace(/^0+/, "");
  if (stripped.length >= 3 && stripped !== digits) out.push(stripped);
  const key = waPhoneKey(search);
  if (key && !out.includes(key)) out.push(key);
  return out;
}

/** Digit strings a stored phone can be recognised by. */
function leadDigitKeys(phone) {
  if (!phone) return [];
  const raw = String(phone).replace(/\D/g, "");
  const keys = raw ? [raw] : [];
  const key = waPhoneKey(phone);
  if (key && !keys.includes(key)) keys.push(key);
  return keys;
}

export function phoneMatches(phone, search) {
  const candidates = searchDigitCandidates(search);
  if (candidates.length === 0) return false;
  const keys = leadDigitKeys(phone);
  return keys.some((key) => candidates.some((c) => key.includes(c)));
}

/**
 * @param {{ customer_name?: string|null, phone?: string|null, location?: string|null, assigned_to?: string|null }} lead
 * @param {string} search raw text from the search box
 */
export function leadMatchesSearch(lead, search) {
  const s = String(search ?? "").toLowerCase().trim();
  if (!s) return true;
  if ((lead.customer_name || "").toLowerCase().includes(s)) return true;
  if ((lead.location || "").toLowerCase().includes(s)) return true;
  if ((lead.assigned_to || "").toLowerCase().includes(s)) return true;
  // Phones match on digits only (≥4), so "123" never lights up half the board.
  return phoneMatches(lead.phone, s);
}
