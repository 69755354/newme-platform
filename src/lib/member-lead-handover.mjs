// S3 #6 — what happens to a salesperson's leads when the member is removed.
//
// Removing a member used to hand every one of their leads to "the active
// sales/operator/boss with the lowest UUID" (effectively a random colleague)
// with one direct `update leads set assigned_to`, so there was no transfer
// history, no business event and no notification. Now the administrator must
// choose: a named receiver, or leave the leads unassigned in the admin queue.
// Each lead then goes through the same audited routines as any other transfer
// (reassign_lead_atomic / unassign_lead_atomic), one lead at a time, with an
// idempotency key derived from the caller's batch key so a retried removal
// replays instead of moving leads twice.
//
// The caller deactivates the member only when every lead was handed over: a
// partial failure leaves the member active so nothing is half-done.

import { deriveLeadTransferKey, isLeadTransferConflict, LEAD_TRANSFER_BATCH_KEY_PATTERN } from "./lead-transfer-batch.mjs";

export const UNASSIGNED_QUEUE = "unassigned";

/**
 * Read the administrator's choice. `transferTo` must be a user id other than
 * the member being removed, or the explicit UNASSIGNED_QUEUE marker. Anything
 * else (missing, empty, the member themself) is refused: there is no default.
 * @returns {{ ok: true, target: string | null } | { ok: false, code: string }}
 */
export function readHandoverTarget(transferTo, memberId) {
  if (transferTo === UNASSIGNED_QUEUE) return { ok: true, target: null };
  if (typeof transferTo !== "string" || !LEAD_TRANSFER_BATCH_KEY_PATTERN.test(transferTo)) {
    return { ok: false, code: "HANDOVER_TARGET_REQUIRED" };
  }
  if (transferTo.toLowerCase() === String(memberId).toLowerCase()) {
    return { ok: false, code: "HANDOVER_TARGET_IS_MEMBER" };
  }
  return { ok: true, target: transferTo };
}

/**
 * Hand every lead the member currently holds to `target` (a user id) or to the
 * unassigned queue (`target === null`), through the audited routines.
 * `client` is the caller's own session client, so the routines see the real
 * actor. Returns a per-lead report; `complete` is true only when nothing failed.
 */
export async function handOverMemberLeads(client, { memberId, target, batchKey, reason = "member_removed" }) {
  if (!LEAD_TRANSFER_BATCH_KEY_PATTERN.test(String(batchKey))) throw new Error("batchKey must be a UUID");
  const { data: leads, error } = await client
    .from("leads")
    .select("id, updated_at")
    .eq("assigned_to", memberId);
  if (error) throw new Error("HANDOVER_LEADS_LOOKUP_FAILED");

  const report = { moved: [], conflicts: [], failed: [], complete: false };
  for (const lead of leads ?? []) {
    const common = {
      p_lead_id: lead.id,
      p_expected_updated_at: lead.updated_at,
      p_idempotency_key: deriveLeadTransferKey(batchKey, lead.id),
      p_reason: reason,
    };
    const { error: rpcError } = target
      ? await client.rpc("reassign_lead_atomic", { ...common, p_new_assignee: target })
      : await client.rpc("unassign_lead_atomic", common);
    if (!rpcError) report.moved.push(lead.id);
    else if (isLeadTransferConflict(rpcError)) report.conflicts.push(lead.id);
    else report.failed.push({ id: lead.id, message: rpcError.message ?? "failed" });
  }
  report.complete = report.conflicts.length === 0 && report.failed.length === 0;
  return report;
}
