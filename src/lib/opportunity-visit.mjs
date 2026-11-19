// Opportunities and visit reports (S23): roles, input checking, the visit status rule and database error mapping.
// Pure functions: no I/O, so the routes, the pages and the tests all use the same rules. The database enforces
// every rule again (constraints, triggers, routines); this file gives early, readable answers.
import { addDaysToDateKey, dubaiDateKey } from "./dubai-time.mjs";

export const STAFF_ROLES = new Set(["admin", "boss", "operator"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const HTTPS = /^https:\/\/\S+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_AMOUNT = 10_000_000_000;
const MIN_DATE = "2020-01-01";
const MAX_DATE = "2100-12-31";
const MIN_TIME = Date.UTC(2020, 0, 1);
const MAX_TIME = Date.UTC(2101, 0, 1);

export const isUuid = (value) => typeof value === "string" && UUID.test(value);

/** admin, boss and operator work on every lead; sales only on a lead assigned to them. */
export function canWorkOnLead(role, userId, lead) {
  if (STAFF_ROLES.has(role)) return true;
  return role === "sales" && Boolean(userId) && lead?.assigned_to === userId;
}

/** Approving plans and reviewing reports. admin and boss are equal. */
export function canReviewVisits(role) {
  return STAFF_ROLES.has(role);
}

/** ISO instant of 09:30 Dubai time on the next working day (Monday to Friday) after the Dubai day of `value`. */
export function nextWorkingDay0930(value) {
  const key = dubaiDateKey(value);
  if (!key) return null;
  const [year, month, day] = key.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 Sunday .. 6 Saturday
  const step = weekday === 5 ? 3 : weekday === 6 ? 2 : 1;
  const [y, m, d] = addDaysToDateKey(key, step).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 9, 30) - 4 * 3600 * 1000).toISOString();
}

/** Same rule as public.visit_report_status(): reviewed > completed > overdue > approved > planned. */
export function visitReportStatus(visit, now = new Date()) {
  const at = (value) => (value === null || value === undefined ? null : new Date(value).getTime());
  const submitted = at(visit.submitted_at);
  const due = at(visit.report_due_at);
  if (submitted !== null && visit.review_status === "accepted") return "reviewed";
  if (submitted !== null) return "completed";
  if (visit.plan_approval !== "rejected" && due !== null && new Date(now).getTime() > due) return "overdue";
  if (visit.plan_approval === "approved") return "approved";
  return "planned";
}

// ---------------------------------------------------------------------------
// Input checking
// ---------------------------------------------------------------------------
const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const isNull = (value) => value === null || (typeof value === "string" && value.trim() === "");

function text(input, key, { max, required = false, errors, out, partial }) {
  if (!(key in input)) { if (required && !partial) errors[key] = "required"; return; }
  const value = input[key];
  if (isBlank(value)) {
    if (required) errors[key] = "required";
    else if (value === null || value === "") out[key] = null;
    return;
  }
  if (typeof value !== "string") { errors[key] = "invalid"; return; }
  const trimmed = value.trim();
  if (trimmed.length > max) { errors[key] = "too_long"; return; }
  out[key] = trimmed;
}

function dateOnly(input, key, { errors, out }) {
  if (!(key in input)) return;
  const value = input[key];
  if (isNull(value)) { out[key] = null; return; }
  const match = typeof value === "string" ? DATE.exec(value.trim()) : null;
  if (!match) { errors[key] = "invalid"; return; }
  const [, y, m, d] = match.map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) { errors[key] = "invalid"; return; }
  const iso = value.trim();
  if (iso < MIN_DATE || iso > MAX_DATE) { errors[key] = "out_of_range"; return; }
  out[key] = iso;
}

function instant(input, key, { errors, out, required = false, partial = false }) {
  if (!(key in input)) { if (required && !partial) errors[key] = "required"; return; }
  const value = input[key];
  if (isNull(value)) { if (required) errors[key] = "required"; else out[key] = null; return; }
  const time = typeof value === "string" && /\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value).getTime() : NaN;
  if (Number.isNaN(time)) { errors[key] = "invalid"; return; }
  if (time < MIN_TIME || time >= MAX_TIME) { errors[key] = "out_of_range"; return; }
  out[key] = new Date(time).toISOString();
}

function link(input, key, { errors, out }) {
  if (!(key in input)) return;
  const value = input[key];
  if (isNull(value)) { out[key] = null; return; }
  if (typeof value !== "string" || value.trim().length > 2000 || !HTTPS.test(value.trim())) { errors[key] = "invalid"; return; }
  out[key] = value.trim();
}

function uuid(input, key, { errors, out, required = false, partial = false }) {
  if (!(key in input)) { if (required && !partial) errors[key] = "required"; return; }
  const value = input[key];
  if (isNull(value)) { if (required) errors[key] = "required"; else out[key] = null; return; }
  if (!isUuid(value)) { errors[key] = "invalid"; return; }
  out[key] = value.toLowerCase();
}

/**
 * Checks an opportunity create (default) or update ({ partial: true, existing }) body. `stages` is the
 * configured stage list ({ key, requires_quote, active }). Only known columns are returned.
 */
export function parseOpportunityInput(input, { stages = [], partial = false, existing = null } = {}) {
  const body = input && typeof input === "object" ? input : {};
  const errors = {};
  const out = {};
  const ctx = { errors, out, partial };
  if (!partial) uuid(body, "lead_id", { ...ctx, required: true });
  text(body, "name", { ...ctx, max: 200, required: true });
  text(body, "confirmed_requirement", { ...ctx, max: 4000, required: true });
  text(body, "closed_reason", { ...ctx, max: 1000 });
  uuid(body, "owner_id", ctx);
  dateOnly(body, "decision_target", ctx);
  link(body, "quotation_link", ctx);
  if ("quote_amount_aed" in body) {
    const raw = body.quote_amount_aed;
    if (isNull(raw)) out.quote_amount_aed = null;
    else {
      const amount = typeof raw === "number" ? raw : /^\d+(\.\d{1,2})?$|^-\d/.test(String(raw).trim()) ? Number(raw) : NaN;
      if (!Number.isFinite(amount)) errors.quote_amount_aed = "invalid";
      else if (amount < 0 || amount >= MAX_AMOUNT) errors.quote_amount_aed = "out_of_range";
      else out.quote_amount_aed = Math.round(amount * 100) / 100;
    }
  }
  if (partial && "archived" in body) {
    if (typeof body.archived === "boolean") out.archived = body.archived; else errors.archived = "invalid";
  }
  if ("stage" in body) {
    const key = typeof body.stage === "string" ? body.stage.trim() : "";
    const stage = STAGE_KEY.test(key) ? stages.find((s) => s.key === key) : null;
    if (!stage) errors.stage = "unknown_stage";
    else if (!stage.active && stage.key !== existing?.stage) errors.stage = "inactive_stage";
    else out.stage = key;
  }
  // The quote rule: a stage that needs a quote needs an amount and a link.
  const merged = { ...(existing ?? {}), ...out };
  const touched = !partial || "stage" in out || "quote_amount_aed" in out || "quotation_link" in out;
  const stageKey = merged.stage ?? "new";
  const stageRow = stages.find((s) => s.key === stageKey);
  if (touched && stageRow?.requires_quote && !errors.stage) {
    if (merged.quote_amount_aed === null || merged.quote_amount_aed === undefined) errors.quote_amount_aed ??= "quote_required";
    if (merged.quotation_link === null || merged.quotation_link === undefined) errors.quotation_link ??= "quote_required";
  }
  if (partial && !Object.keys(errors).length && !Object.keys(out).length) errors._ = "nothing_to_update";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** Checks a visit create (default) or update ({ partial: true }) body. Workflow columns are never accepted. */
export function parseVisitInput(input, { partial = false } = {}) {
  const body = input && typeof input === "object" ? input : {};
  const errors = {};
  const out = {};
  const ctx = { errors, out, partial };
  if (!partial) uuid(body, "lead_id", { ...ctx, required: true });
  uuid(body, "opportunity_id", ctx);
  uuid(body, "owner_id", ctx);
  instant(body, "planned_at", { ...ctx, required: true });
  text(body, "location", { ...ctx, max: 300 });
  text(body, "person_to_meet", { ...ctx, max: 300 });
  text(body, "purpose", { ...ctx, max: 2000, required: true });
  instant(body, "actual_start", ctx);
  instant(body, "actual_finish", ctx);
  text(body, "result", { ...ctx, max: 4000 });
  text(body, "next_action", { ...ctx, max: 2000 });
  dateOnly(body, "next_followup_date", ctx);
  link(body, "evidence_link", ctx);
  if (partial && "archived" in body) {
    if (typeof body.archived === "boolean") out.archived = body.archived; else errors.archived = "invalid";
  }
  if (out.actual_start && out.actual_finish && new Date(out.actual_finish) < new Date(out.actual_start)) errors.actual_finish = "before_start";
  if (partial && !Object.keys(errors).length && !Object.keys(out).length) errors._ = "nothing_to_update";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** Database error to a stable code and HTTP status. The message of an unknown error is never passed on. */
export function mapDbError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  if (["42P01", "42883", "PGRST205", "PGRST202"].includes(code)) return { status: 503, code: "feature_unavailable" };
  if (code === "23505") return { status: 409, code: "duplicate" };
  if (code === "23503") return { status: 422, code: "unknown_reference" };
  if (code === "42501") return { status: 403, code: "forbidden" };
  if (code === "23514") {
    if (message === "visit_report_locked") return { status: 409, code: "visit_report_locked" };
    if (/^opportunity_(quote_required|stage_inactive)$/.test(message)) return { status: 422, code: message };
    return { status: 422, code: "invalid_value" };
  }
  if (code === "22023") {
    if (message === "unknown_visit") return { status: 404, code: "unknown_visit" };
    if (/^(visit_plan_not_approved|visit_report_incomplete|visit_already_submitted|visit_not_submitted)$/.test(message)) return { status: 409, code: message };
    if (/^(invalid_plan_decision|invalid_review_decision|review_note_required)$/.test(message)) return { status: 422, code: message };
    return { status: 422, code: "invalid_value" };
  }
  return { status: 500, code: "internal" };
}

// Dubai wall-clock <-> instant, for <input type="datetime-local"> (no zone in the value).
const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;
/** "2026-11-25T14:30" (Dubai time) to an ISO instant, or null. */
export function dubaiLocalToIso(value) {
  const match = typeof value === "string" ? LOCAL.exec(value) : null;
  if (!match) return null;
  const time = new Date(`${match[1]}T${match[2]}:00+04:00`).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
/** An ISO instant to "YYYY-MM-DDTHH:mm" in Dubai time, or "". */
export function isoToDubaiLocal(value) {
  const time = value ? new Date(value).getTime() : NaN;
  if (Number.isNaN(time)) return "";
  return new Date(time + 4 * 3600 * 1000).toISOString().slice(0, 16);
}
