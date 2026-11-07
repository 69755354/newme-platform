// Lead contact rules shared by every lead entry point (new-lead page, quick
// create dialog, lead-detail inline edit, website intake) and by the duplicate
// lookup. Pure functions so the browser, the server and node:test all run the
// same code.
//
// Phone numbers are stored in E.164 ("+971501234567"). The business is in the
// UAE, so a number written without a country code is read as a UAE number:
//   0501234567 / 050 123 4567 / 050-123-4567  -> +971501234567 (local mobile)
//   501234567                                -> +971501234567 (mobile, no 0)
//   042345678                                -> +97142345678  (local landline)
//   00971501234567 / 971501234567            -> +971501234567
//   +971 050 123 4567                        -> +971501234567 (stray trunk 0)
// Any other "+<country>" or "00<country>" number is kept in E.164 when it has
// 8–15 digits. Anything else is rejected rather than guessed.

export const LEAD_FIELD_LIMITS = Object.freeze({
  customer_name: 100,
  phone: 40,
  email: 254,
  location: 200,
  notes: 2000,
  override_reason: 500,
});

export const LEAD_NAME_MIN_LENGTH = 2;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SEPARATORS = /[\s().\-/ ]/g;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, e164: string } | { ok: false, code: "phone_empty" | "invalid_phone" }}
 */
export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return { ok: false, code: "phone_empty" };
  if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, code: "invalid_phone" };
  const text = String(raw).trim();
  if (!text) return { ok: false, code: "phone_empty" };
  if (text.length > LEAD_FIELD_LIMITS.phone) return { ok: false, code: "invalid_phone" };

  let compact = text.replace(SEPARATORS, "");
  let international = false;
  if (compact.startsWith("+")) {
    international = true;
    compact = compact.slice(1);
  } else if (compact.startsWith("00")) {
    international = true;
    compact = compact.slice(2);
  }
  if (!/^\d+$/.test(compact)) return { ok: false, code: "invalid_phone" };

  let digits;
  if (international) {
    digits = compact;
  } else if (compact.startsWith("971") && (compact.length === 11 || compact.length === 12 || compact.length === 13)) {
    digits = compact;
  } else if (compact.startsWith("0") && !compact.startsWith("00") && (compact.length === 9 || compact.length === 10)) {
    digits = `971${compact.slice(1)}`;
  } else if (compact.length === 9 && compact.startsWith("5")) {
    digits = `971${compact}`;
  } else {
    return { ok: false, code: "invalid_phone" };
  }

  if (digits.startsWith("971")) {
    let national = digits.slice(3);
    if (national.startsWith("0")) national = national.slice(1);
    // UAE: mobiles are 5XXXXXXXX (9 digits), landlines 8 digits (e.g. 4XXXXXXX).
    const mobile = /^5\d{8}$/.test(national);
    const landline = /^[2-9]\d{7}$/.test(national);
    if (!mobile && !landline) return { ok: false, code: "invalid_phone" };
    return { ok: true, e164: `+971${national}` };
  }

  if (digits.startsWith("0") || digits.length < 8 || digits.length > 15) {
    return { ok: false, code: "invalid_phone" };
  }
  return { ok: true, e164: `+${digits}` };
}

/** E.164 form of a stored phone, or null when it cannot be read as one. */
export function phoneMatchKey(raw) {
  const result = normalizePhone(raw);
  return result.ok ? result.e164 : null;
}

/** https://wa.me link for a stored phone in any accepted format, or null. */
export function whatsappHref(raw) {
  const e164 = phoneMatchKey(raw);
  return e164 ? `https://wa.me/${e164.slice(1)}` : null;
}

/** tel: link for a stored phone in any accepted format, or null. */
export function telHref(raw) {
  const e164 = phoneMatchKey(raw);
  return e164 ? `tel:${e164}` : null;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, email: string } | { ok: false, code: "email_empty" | "invalid_email" }}
 */
export function normalizeEmail(raw) {
  if (raw === null || raw === undefined) return { ok: false, code: "email_empty" };
  if (typeof raw !== "string") return { ok: false, code: "invalid_email" };
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, code: "email_empty" };
  if (email.length > LEAD_FIELD_LIMITS.email || !EMAIL.test(email)) {
    return { ok: false, code: "invalid_email" };
  }
  return { ok: true, email };
}

function optionalText(value, max, field, errors) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    errors[field] = "invalid";
    return null;
  }
  const text = value.trim();
  if (text.length > max) {
    errors[field] = "too_long";
    return null;
  }
  return text || null;
}

/**
 * Validate and normalise a new lead. Returns field error codes keyed by field
 * (codes, not prose, so each surface localises them).
 *
 * Rules: a name of at least two characters, plus at least one valid contact
 * (phone or email). A contact that is present must be valid even when the
 * other one is fine, so a typo is never silently stored.
 */
export function validateNewLead(input) {
  const source = input && typeof input === "object" ? input : {};
  const errors = {};

  const name = optionalText(source.customer_name, LEAD_FIELD_LIMITS.customer_name, "customer_name", errors);
  if (!errors.customer_name && (!name || name.length < LEAD_NAME_MIN_LENGTH)) {
    errors.customer_name = "required";
  }

  let phone = null;
  const phoneResult = normalizePhone(source.phone);
  if (phoneResult.ok) phone = phoneResult.e164;
  else if (phoneResult.code === "invalid_phone") errors.phone = "invalid";

  let email = null;
  const emailResult = normalizeEmail(source.email);
  if (emailResult.ok) email = emailResult.email;
  else if (emailResult.code === "invalid_email") errors.email = "invalid";

  if (!phone && !email && !errors.phone && !errors.email) {
    errors.contact = "required";
  }

  const location = optionalText(source.location, LEAD_FIELD_LIMITS.location, "location", errors);
  const notes = optionalText(source.notes, LEAD_FIELD_LIMITS.notes, "notes", errors);

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { customer_name: name, phone, email, location, notes },
  };
}

/**
 * Validate one inline-edited lead field. Returns the value to store or an
 * error code. Fields without a rule pass through unchanged.
 */
export function validateLeadFieldEdit(field, value) {
  switch (field) {
    case "customer_name": {
      const text = typeof value === "string" ? value.trim() : "";
      if (text.length > LEAD_FIELD_LIMITS.customer_name) return { ok: false, code: "too_long" };
      if (text.length < LEAD_NAME_MIN_LENGTH) return { ok: false, code: "required" };
      return { ok: true, value: text };
    }
    case "phone": {
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
        return { ok: true, value: null };
      }
      const result = normalizePhone(value);
      return result.ok ? { ok: true, value: result.e164 } : { ok: false, code: "invalid" };
    }
    case "email": {
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
        return { ok: true, value: null };
      }
      const result = normalizeEmail(value);
      return result.ok ? { ok: true, value: result.email } : { ok: false, code: "invalid" };
    }
    case "location": {
      if (typeof value !== "string") return { ok: true, value: value ?? null };
      const text = value.trim();
      if (text.length > LEAD_FIELD_LIMITS.location) return { ok: false, code: "too_long" };
      return { ok: true, value: text || null };
    }
    default:
      return { ok: true, value };
  }
}

/**
 * Of the candidate rows, the ones that are the same customer: same E.164 phone
 * (whatever format the row was stored in) or the same email, case-insensitive.
 */
export function matchDuplicateLeads(rows, { phone, email, excludeId } = {}) {
  const phoneKey = phone ? phoneMatchKey(phone) : null;
  const emailKey = email ? normalizeEmail(email) : null;
  const wantedEmail = emailKey && emailKey.ok ? emailKey.email : null;
  const seen = new Set();
  const matches = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.id !== "string" || row.id === excludeId || seen.has(row.id)) continue;
    const byPhone = Boolean(phoneKey) && phoneMatchKey(row.phone) === phoneKey;
    const rowEmail = typeof row.email === "string" ? row.email.trim().toLowerCase() : null;
    const byEmail = Boolean(wantedEmail) && rowEmail === wantedEmail;
    if (!byPhone && !byEmail) continue;
    seen.add(row.id);
    matches.push({ ...row, matched_on: byPhone && byEmail ? "phone_email" : byPhone ? "phone" : "email" });
  }
  return matches;
}

/**
 * Search pattern for the candidate query: the last four digits of the E.164
 * number. Every stored format of the same number ends in those digits as long
 * as its last group has four digits, which covers E.164, local and the usual
 * "050 123 4567" spellings. Digits only, so it can never inject a wildcard.
 */
export function phoneSearchSuffix(phone) {
  const key = phoneMatchKey(phone);
  return key ? key.slice(-4) : null;
}
