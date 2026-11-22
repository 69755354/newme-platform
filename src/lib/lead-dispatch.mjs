// Lead dispatch states, phone review and duplicate review (S24): roles, input checking, the actions the
// workbench offers and database error mapping. Pure functions: no I/O, so the routes, the pages and the tests
// all use the same rules. The database enforces every rule again (constraints and routines); this file gives
// early, readable answers.

export const STAFF_ROLES = new Set(["admin", "boss", "operator"]);

/** Display order: the states that need a person first. */
export const DISPATCH_STATUSES = Object.freeze([
  "missing_intake_data", "review_phone", "duplicate_review", "unassigned",
  "delivered", "duplicate_not_dispatched", "excluded_test",
]);
export const ATTENTION_STATUSES = Object.freeze(DISPATCH_STATUSES.slice(0, 4));
export const DUPLICATE_DECISIONS = Object.freeze(["merged", "kept_separate", "invalid"]);
export const DECISION_ACTIONS = Object.freeze([
  "confirm_phone", "release_missing", "revoke_release", "mark_test", "unmark_test", "note", "reevaluate",
]);
export const SWEEP_WINDOW_DAYS = 7;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === "string" && UUID.test(value);

/** admin, boss and operator decide. admin and boss are equal. */
export function canDecide(role) {
  return STAFF_ROLES.has(role);
}

const MIN_REASON = { release_missing: 10, mark_test: 5, unmark_test: 5, note: 1 };
const MAX_TEXT = 1000;

function cleanText(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  return { ok: true, value: text === "" ? null : text };
}

/** Body of POST /api/dispatch/{leadId}/decide. */
export function parseDecideInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: { body: "invalid" } };
  if (!DECISION_ACTIONS.includes(input.action)) return { ok: false, errors: { action: "invalid" } };
  const reason = cleanText(input.reason);
  if (!reason.ok) return { ok: false, errors: { reason: "invalid" } };
  if (reason.value !== null && reason.value.length > MAX_TEXT) return { ok: false, errors: { reason: "too_long" } };
  const min = MIN_REASON[input.action] ?? 0;
  if (min > 0 && (reason.value === null || reason.value.length < min)) return { ok: false, errors: { reason: "required" } };
  return { ok: true, value: { action: input.action, reason: reason.value } };
}

/** Body of POST /api/duplicates/{id}/resolve. */
export function parseResolveInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: { body: "invalid" } };
  if (!DUPLICATE_DECISIONS.includes(input.decision)) return { ok: false, errors: { decision: "invalid" } };
  const notes = cleanText(input.notes);
  if (!notes.ok) return { ok: false, errors: { notes: "invalid" } };
  if (notes.value !== null && notes.value.length > MAX_TEXT) return { ok: false, errors: { notes: "too_long" } };
  if (input.decision !== "merged" && (notes.value === null || notes.value.length < 5)) return { ok: false, errors: { notes: "required" } };
  return { ok: true, value: { decision: input.decision, notes: notes.value } };
}

/** Body of POST /api/duplicates/{id}/reopen. */
export function parseReopenInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: { body: "invalid" } };
  const reason = cleanText(input.reason);
  if (!reason.ok || reason.value === null || reason.value.length < 5) return { ok: false, errors: { reason: "required" } };
  if (reason.value.length > MAX_TEXT) return { ok: false, errors: { reason: "too_long" } };
  return { ok: true, value: { reason: reason.value } };
}

/** The actions worth showing for one state row. */
export function allowedActions(row) {
  const actions = [];
  if (row?.phone_flag === "suspect") actions.push("confirm_phone");
  const missing = Array.isArray(row?.missing_fields) ? row.missing_fields.length : 0;
  if (row?.release_reason) actions.push("revoke_release");
  else if (missing > 0) actions.push("release_missing");
  actions.push(row?.status === "excluded_test" ? "unmark_test" : "mark_test");
  actions.push("note", "reevaluate");
  return actions;
}

/** ISO start of the sweep window used by the application (the backfill script uses its own, much older, date). */
export function sweepWindowStart(now = new Date()) {
  return new Date(new Date(now).getTime() - SWEEP_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
}

const CONFLICTS = /^(review_already_decided|pending_review_exists|nothing_to_release|lead_has_no_dispatch_state|phone_not_confirmable)$/;
const UNPROCESSABLE = /^(reason_required|review_note_required|invalid_dispatch_action|invalid_duplicate_decision)$/;

export function mapDbError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  if (["42P01", "42883", "PGRST205", "PGRST202"].includes(code)) return { status: 503, code: "feature_unavailable" };
  if (code === "42501") return { status: 403, code: "forbidden" };
  if (code === "23505") return { status: 409, code: "duplicate" };
  if (code === "23514") return { status: 422, code: "invalid_value" };
  if (code === "22023") {
    if (message === "unknown_lead" || message === "unknown_review") return { status: 404, code: message };
    if (CONFLICTS.test(message)) return { status: 409, code: message };
    if (UNPROCESSABLE.test(message)) return { status: 422, code: message };
    return { status: 422, code: "invalid_value" };
  }
  return { status: 500, code: "internal" };
}

/**
 * S35: can the dispatch queue hand this row to a salesperson right now? Only a lead that nobody owns, in the "unassigned"
 * state (complete and clean). Leads still under duplicate review or missing data are fixed first, not assigned.
 */
export function canAssignFromQueue(row) {
  return row?.status === "unassigned" && Boolean(row?.lead) && !row.lead.assigned_to;
}

/**
 * S35: the request that assigns a queue row to a salesperson. It is the ordinary reassignment API
 * (POST /api/leads/:id/assignment): the same role check (admin, boss, operator), the same compare-and-set on the lead's
 * updated_at, the same bell notification to the new owner. The queue adds nothing of its own.
 */
export function buildQueueAssignRequest(row, assigneeId, idempotencyKey) {
  if (!canAssignFromQueue(row) || !isUuid(assigneeId) || !isUuid(idempotencyKey)) return null;
  return {
    url: `/api/leads/${row.lead_id}/assignment`,
    body: { assignedTo: assigneeId, expectedUpdatedAt: row.lead.updated_at ?? null, idempotencyKey, reason: "dispatch_queue_assign" },
  };
}
