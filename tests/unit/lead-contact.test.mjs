// S3 #4/#5 — phone normalisation, duplicate matching and new-lead validation.
import assert from "node:assert/strict";
import test from "node:test";
import {
  LEAD_FIELD_LIMITS,
  matchDuplicateLeads,
  normalizeEmail,
  normalizePhone,
  phoneSearchSuffix,
  validateLeadFieldEdit,
  validateNewLead,
  whatsappHref,
} from "../../src/lib/lead-contact.mjs";

test("every UAE spelling of one mobile normalises to the same E.164 number", () => {
  for (const raw of [
    "+971501234567", "+971 50 123 4567", "+971-50-123-4567", "00971501234567",
    "00 971 50 123 4567", "971501234567", "0501234567", "050 123 4567", "050-123-4567",
    "(050) 123-4567", "501234567", "+971 050 123 4567",
  ]) {
    assert.deepEqual(normalizePhone(raw), { ok: true, e164: "+971501234567" }, raw);
  }
});

test("UAE landlines and foreign numbers with a country code are accepted", () => {
  assert.deepEqual(normalizePhone("04 234 5678"), { ok: true, e164: "+97142345678" });
  assert.deepEqual(normalizePhone("+44 7911 123456"), { ok: true, e164: "+447911123456" });
  assert.deepEqual(normalizePhone("0086 138 0013 8000"), { ok: true, e164: "+8613800138000" });
});

test("letters, short numbers and unguessable formats are rejected", () => {
  for (const raw of ["abc-not-phone", "abc-invalid", "12345", "+971 12", "+971 50 123", "0012", "447911123456", "+0123456789"]) {
    assert.equal(normalizePhone(raw).ok, false, raw);
  }
  assert.deepEqual(normalizePhone(""), { ok: false, code: "phone_empty" });
  assert.deepEqual(normalizePhone(null), { ok: false, code: "phone_empty" });
});

test("wa.me links built from local formats carry the country code", () => {
  assert.equal(whatsappHref("0500000103"), "https://wa.me/971500000103");
  assert.equal(whatsappHref("00971500000104"), "https://wa.me/971500000104");
  assert.equal(whatsappHref("+971-50-000-0105"), "https://wa.me/971500000105");
  assert.equal(whatsappHref("abc"), null);
  assert.equal(whatsappHref(null), null);
});

test("emails are trimmed, lower-cased and validated", () => {
  assert.deepEqual(normalizeEmail("  QA-B-1@Example.COM "), { ok: true, email: "qa-b-1@example.com" });
  assert.equal(normalizeEmail("not-an-email").ok, false);
  assert.equal(normalizeEmail("a@b").ok, false);
});

test("an empty lead is refused: a name and one valid contact are required", () => {
  const empty = validateNewLead({});
  assert.equal(empty.ok, false);
  assert.equal(empty.errors.customer_name, "required");
  assert.equal(empty.errors.contact, "required");

  const nameOnly = validateNewLead({ customer_name: "Ahmed" });
  assert.deepEqual(nameOnly, { ok: false, errors: { contact: "required" } });

  const phoneOnly = validateNewLead({ phone: "0501234567" });
  assert.deepEqual(phoneOnly, { ok: false, errors: { customer_name: "required" } });
});

test("present contacts must be valid even when the other one is fine", () => {
  const badPhone = validateNewLead({ customer_name: "Ahmed", phone: "abc-not-phone", email: "a@example.com" });
  assert.deepEqual(badPhone, { ok: false, errors: { phone: "invalid" } });
  const badEmail = validateNewLead({ customer_name: "Ahmed", phone: "0501234567", email: "not-an-email" });
  assert.deepEqual(badEmail, { ok: false, errors: { email: "invalid" } });
});

test("over-long text fields are refused instead of breaking layouts", () => {
  const long = validateNewLead({
    customer_name: "x".repeat(LEAD_FIELD_LIMITS.customer_name + 1),
    phone: "0501234567",
    location: "y".repeat(LEAD_FIELD_LIMITS.location + 1),
    notes: "z".repeat(LEAD_FIELD_LIMITS.notes + 1),
  });
  assert.deepEqual(long, {
    ok: false,
    errors: { customer_name: "too_long", location: "too_long", notes: "too_long" },
  });
});

test("a valid lead comes back normalised", () => {
  assert.deepEqual(
    validateNewLead({ customer_name: "  Ahmed  ", phone: "050 123 4567", email: " A@Example.com ", location: " Dubai ", notes: "" }),
    { ok: true, value: { customer_name: "Ahmed", phone: "+971501234567", email: "a@example.com", location: "Dubai", notes: null } },
  );
});

test("inline edits normalise phone/email and refuse invalid or over-long values", () => {
  assert.deepEqual(validateLeadFieldEdit("phone", "0501234567"), { ok: true, value: "+971501234567" });
  assert.deepEqual(validateLeadFieldEdit("phone", "abc-invalid"), { ok: false, code: "invalid" });
  assert.deepEqual(validateLeadFieldEdit("phone", ""), { ok: true, value: null });
  assert.deepEqual(validateLeadFieldEdit("email", "x@Y.com"), { ok: true, value: "x@y.com" });
  assert.deepEqual(validateLeadFieldEdit("customer_name", "n".repeat(310)), { ok: false, code: "too_long" });
  assert.deepEqual(validateLeadFieldEdit("location", "l".repeat(500)), { ok: false, code: "too_long" });
  assert.deepEqual(validateLeadFieldEdit("area", "anything"), { ok: true, value: "anything" });
});

test("duplicates match across stored phone formats and email case", () => {
  const rows = [
    { id: "a", phone: "0501234567", email: null },
    { id: "b", phone: "+971 50 123 4567", email: null },
    { id: "c", phone: "+971509999999", email: "Same@Example.com" },
    { id: "d", phone: "+971501230000", email: null },
    { id: "self", phone: "+971501234567", email: null },
  ];
  const found = matchDuplicateLeads(rows, { phone: "00971501234567", email: "same@example.com", excludeId: "self" });
  assert.deepEqual(found.map((row) => [row.id, row.matched_on]), [["a", "phone"], ["b", "phone"], ["c", "email"]]);
  assert.equal(phoneSearchSuffix("050 123 4567"), "4567");
  assert.equal(phoneSearchSuffix("garbage"), null);
});
