// S3 #3 — what the user sees after a reassignment request, and the state the
// page must keep for the next one. reassign_lead_atomic() is a compare-and-set
// on leads.updated_at, so the page must carry the token the database left
// behind; a stale token is a real conflict and is shown as one, localised,
// never as the raw database code.

/** Translation key for a failed reassignment response. */
export function reassignFailureKey(status, code) {
  const text = typeof code === "string" ? code : "";
  if (status === 409 || text.includes("CONCURRENT")) return "leadFlow.reassign.conflict";
  if (status === 403 || text.includes("FORBIDDEN")) return "leadFlow.reassign.forbidden";
  if (text.includes("INVALID_ASSIGNEE")) return "leadFlow.reassign.invalidAssignee";
  return "leadFlow.reassign.failed";
}

/** A conflict means the page is stale and must reload before another try. */
export function reassignNeedsReload(status, code) {
  return reassignFailureKey(status, code) === "leadFlow.reassign.conflict";
}

/**
 * The lead after a successful reassignment: new owner, and the updated_at the
 * routine returned, so a second reassignment from the same page compares
 * against the current row instead of the one loaded before the first.
 */
export function applyReassignResult(lead, { assignedTo, repName, result }) {
  const updatedAt = result && typeof result.updated_at === "string" ? result.updated_at : lead.updated_at;
  return { ...lead, assigned_to: assignedTo, rep_name: repName, updated_at: updatedAt };
}
