// Server-owned audit evidence, never customer rows. Registration must precede
// creation of a test lead and remain after cleanup to fence late replays.
import { createHash } from "node:crypto";

export const TEST_FORM_ACTION = "META_LEADGEN_TEST_FORM_REGISTERED";
export const TEST_RECEIPT_ACTION = "META_LEADGEN_TEST_RECEIVED";
const TARGET = "meta_leadgen_test";
const ID = /^[1-9]\d{4,31}$/;
const BATCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = value => {
  if (typeof value !== "string" || !ID.test(value)) throw Error("test_identity_invalid");
  return value;
};
const stableUuid = value => {
  const h = createHash("sha256").update(`newme/meta-lead-test/v1/${value}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function testFormRegistration({ pageId, formId, batchId }) {
  identifier(pageId); identifier(formId);
  if (!BATCH.test(batchId ?? "")) throw Error("test_batch_invalid");
  return { id: stableUuid(`form/${formId}`), action: TEST_FORM_ACTION, target_type: TARGET,
    details: { schema: 1, page_id: pageId, form_id: formId, batch_id: batchId } };
}

export async function lookupTestForm(db, formId) {
  identifier(formId); // Missing identity is not permission to enter production.
  const id = stableUuid(`form/${formId}`);
  const result = await db.from("audit_logs").select("id, action, target_type, details").eq("id", id).limit(1);
  if (result.error || !Array.isArray(result.data)) throw Error("test_registry_lookup_failed");
  if (!result.data.length) return null;
  const row = result.data[0];
  const d = row.details;
  if (!d || d.schema !== 1 || d.form_id !== formId || !ID.test(d.page_id ?? "") || !BATCH.test(d.batch_id ?? "") ||
      row.id !== id || row.action !== TEST_FORM_ACTION || row.target_type !== TARGET) throw Error("test_registry_invalid");
  return d;
}

export async function isolateTestLead(db, row, origin = "backfill") {
  if (!["webhook", "backfill"].includes(origin)) throw Error("test_origin_invalid");
  const registration = await lookupTestForm(db, row.form_id);
  if (!registration) return false;
  const leadId = identifier(row.meta_leadgen_id);
  const receipt = { id: stableUuid(`receipt/${registration.batch_id}/${leadId}/${origin}`),
    action: TEST_RECEIPT_ACTION, target_type: TARGET,
    details: { schema: 1, page_id: registration.page_id, form_id: registration.form_id,
      batch_id: registration.batch_id, leadgen_id: leadId, origin, graph_fetched: true } };
  // No names, contact values, raw answers or conversion payloads survive here.
  // Different origins have distinct IDs: backfill cannot masquerade as a callback.
  const result = await db.from("audit_logs").insert(receipt);
  if (result.error && result.error.code !== "23505") throw Error("test_receipt_write_failed");
  const check = await db.from("audit_logs").select("id, action, target_type, details").eq("id", receipt.id).limit(1);
  const actual = check.data?.[0];
  if (check.error || actual?.action !== receipt.action || actual?.target_type !== TARGET ||
      Object.keys(receipt.details).some(key => actual?.details?.[key] !== receipt.details[key])) {
    throw Error("test_receipt_readback_failed");
  }
  return true;
}
