/**
 * The decisions a *batch* of lead transfers has to make, as plain functions.
 *
 * Round-4 finding R6. public.reassign_lead_atomic() is the only writer of
 * public.transfer_history and the only compare-and-set on a lead's owner, and it
 * requires two things from its caller that a batch cannot produce by accident:
 *
 *   p_expected_updated_at  the token the caller compared against. Passing NULL
 *                          is accepted and silently skips the comparison, so a
 *                          caller that "forgets" it gets a lost update with no
 *                          error — see the header of
 *                          supabase/migrations/20260817180000_leads_updated_at_is_server_owned.sql.
 *   p_idempotency_key      a uuid, non-null or the routine refuses. A key minted
 *                          per attempt makes every retry a fresh transfer, which
 *                          is the defect, not a fix for it (same reasoning as
 *                          readIdempotencyKey in src/lib/payment-idempotency.mjs).
 *
 * A batch has N leads and one user gesture, so the key has to be *derived*: one
 * caller-supplied batch key, one deterministic key per lead. Then a retried
 * batch — a double-clicked button, a dropped response, a client that resends —
 * presents the same keys and the routine replays instead of moving the leads a
 * second time.
 *
 * These live outside the route and the server action for the reason
 * src/lib/payment-idempotency.mjs gives: the derivation is the part worth
 * testing by running it. A test that only reads the route's source can assert
 * that a key is spelled there, not that two leads in one batch get different
 * keys or that the same lead in two attempts gets the same one.
 */

import { createHash } from "node:crypto";

/** Version-agnostic RFC 4122 form, matching the other key checks in this repo. */
export const LEAD_TRANSFER_BATCH_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Namespace for derived lead-transfer keys.
 *
 * A fixed namespace means a derived key cannot collide with a key from another
 * domain even if the same batch key were reused there, and it makes the
 * derivation reproducible outside this process — the same batch key and lead id
 * always name the same operation, which is what lets a retry find it.
 */
const LEAD_TRANSFER_KEY_NAMESPACE = "6f2b4d1e-3c8a-4b57-9e0d-1a7c5f83b264";

function uuidBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/**
 * The batch key a request carries, lower-cased, or null if it carries none we
 * can use.
 *
 * Null is a 400, never a generated key. Minting one here would defeat the whole
 * point: the caller is the only party that survives a retry.
 */
export function readLeadTransferBatchKey({ body, headerValue } = {}) {
  const fromBody = body && typeof body.batchKey === "string" ? body.batchKey.trim() : "";
  const fromHeader = typeof headerValue === "string" ? headerValue.trim() : "";
  if (fromBody && fromHeader && fromBody.toLowerCase() !== fromHeader.toLowerCase()) return null;
  const candidate = (fromBody || fromHeader).toLowerCase();
  return LEAD_TRANSFER_BATCH_KEY_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The idempotency key for one lead inside one batch: RFC 4122 v5 over
 * `${batchKey}:${leadId}` in the namespace above.
 *
 * Deterministic in the pair and nothing else. Deliberately NOT a function of the
 * chosen assignee: a batch that partially succeeds changes the loads it was
 * computed from, so a retry may pick different targets, and keying on the target
 * would let the leads already moved by attempt 1 move again. Keying on the lead
 * means attempt 2 finds those keys spent and replays them — the routine returns
 * the recorded response with `idempotent_replay: true`, which the caller reports
 * separately from a transfer it actually performed.
 *
 * Throws on anything that is not a pair of uuids. A key derived from a malformed
 * input would still be a valid-looking uuid, and two different malformed inputs
 * could normalise to the same one; refusing is the only safe answer.
 */
export function deriveLeadTransferKey(batchKey, leadId) {
  if (typeof batchKey !== "string" || !LEAD_TRANSFER_BATCH_KEY_PATTERN.test(batchKey)) {
    throw new Error("deriveLeadTransferKey requires a uuid batch key");
  }
  if (typeof leadId !== "string" || !LEAD_TRANSFER_BATCH_KEY_PATTERN.test(leadId)) {
    throw new Error("deriveLeadTransferKey requires a uuid lead id");
  }
  const digest = createHash("sha256")
    .update(uuidBytes(LEAD_TRANSFER_KEY_NAMESPACE))
    .update(Buffer.from(`${batchKey.toLowerCase()}:${leadId.toLowerCase()}`, "utf8"))
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version-5-shaped deterministic key
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Whether a value can be the compare-and-set token.
 *
 * `leads.updated_at` is timestamptz and PostgREST renders it as ISO 8601 with
 * microseconds. We do not reformat it — the routine compares timestamptz to
 * timestamptz, and reformatting is how microseconds get lost and a comparison
 * that should have failed starts passing. All this checks is that the caller
 * sent a timestamp at all, because NULL is the value that turns the comparison
 * off.
 */
export function isLeadUpdatedAtToken(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

/** Whether a PostgREST error is reassign_lead_atomic() refusing on a moved row. */
export function isLeadTransferConflict(error) {
  if (!error) return false;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`;
  return /CONCURRENT_LEAD_UPDATE/.test(text);
}

/**
 * What one reassign_lead_atomic() return value means for a batch tally.
 *
 *   "transferred" the routine moved the lead and wrote the four audit rows
 *   "replayed"    this key was already spent by an earlier attempt; nothing
 *                 moved now, and something moved then
 *   "unchanged"   the lead already belonged to the target
 *
 * Kept apart on purpose. Counting a replay or a no-op as a transfer is how a
 * batch reports "rebalanced 40 leads" after moving none of them, and this route
 * already had a bug of that family (SAM-43: `transferred: updates.length`).
 */
export function classifyLeadReassignResult(result) {
  const row = result && typeof result === "object" ? result : {};
  if (row.idempotent_replay === true) return "replayed";
  if (row.unchanged === true) return "unchanged";
  return "transferred";
}
