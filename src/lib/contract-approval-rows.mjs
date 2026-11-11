// S16: make sure a contract awaiting an approval step has a pending contract_approvals
// row for that step.
//
// The conversion and create_contract routines open the first row, and
// approve_contract() opens the boss step. A contract that was REJECTED and is then
// resubmitted (set_contract_status -> pending_admin) gets no new row, because the
// earlier one is settled. approve_contract() tolerates that (it backfills the
// decision), but the "pending approval" notification is keyed on the pending row, so
// without one the notification could not be built and was only logged.
//
// Written with the service-role client: contract_approvals inserts are definer-only
// for end users. Idempotent and best effort: it never throws, so a failure cannot
// fail the status change that already committed.

/**
 * @param {{ from(table: string): any }} admin service-role client
 * @param {{ contractId: string, step: "admin_review" | "ceo_review", source: string }} input
 * @returns {Promise<{ created: boolean, error?: { message?: string } }>}
 */
export async function ensurePendingApproval(admin, { contractId, step, source }) {
  try {
    const existing = await admin
      .from("contract_approvals")
      .select("id")
      .eq("contract_id", contractId)
      .eq("step", step)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (existing.error) return { created: false, error: existing.error };
    if (existing.data) return { created: false };
    const inserted = await admin
      .from("contract_approvals")
      .insert({ contract_id: contractId, step, status: "pending", notes: { source } });
    if (inserted.error) return { created: false, error: inserted.error };
    return { created: true };
  } catch (error) {
    return { created: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}
