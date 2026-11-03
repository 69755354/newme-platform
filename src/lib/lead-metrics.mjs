// One definition of every lead number shown in NEWME OS.
//
// Before this module the dashboard, analytics, team ownership, weekly review and
// the two ads-attribution pages each counted leads their own way, so the boss saw
// 123 leads in one place (archived rows included) and 120 in another, three
// different "won" figures (today / all time / this month, none labelled), overdue
// "129d" next to "128d", and 114 vs 117 between /ads and /settings/ads. Every
// route and page that reports these numbers now derives them here:
//
//   * counted lead        archived = false. Archived rows are history, never stock.
//   * outcome             final_status when set, otherwise the process stage.
//   * active (pipeline)   counted and outcome is neither won nor lost.
//   * won / lost          outcome is won / lost.
//   * won in a period     won and won_at inside the Dubai period bounds
//                         (won_at is set by trg_set_won_at for every path that
//                         sets final_status = 'won', including quote conversion).
//   * conversion rate     won / counted leads of the same population, whole %.
//   * follow-up overdue   active, and next_followup_date has passed, or never
//                         contacted 48h after creation. Days late are whole Dubai
//                         calendar days (see dubai-time.mjs).
//   * quality bucket      quality, falling back to ai_quality, folded into
//                         pending / good / normal / bad / unknown.
//
// All period and day math lives in dubai-time.mjs.
import { dubaiDaysBetween, inBounds } from "./dubai-time.mjs";

export const NEVER_CONTACTED_GRACE_MS = 48 * 3600 * 1000;
export const STALE_YELLOW_DAYS = 7;
export const STALE_RED_DAYS = 14;

export const PROCESS_STAGES = Object.freeze([
  "new",
  "contacted",
  "requirement_confirmed",
  "solution_submitted",
  "quotation_submitted",
  "negotiation",
  "pending_decision",
]);
export const OUTCOME_KEYS = Object.freeze([...PROCESS_STAGES, "won", "lost"]);
const CONTACTED_STAGES = new Set(PROCESS_STAGES.slice(1));
export const QUOTED_STAGES = Object.freeze(["quotation_submitted", "negotiation", "pending_decision"]);
const QUOTED = new Set(QUOTED_STAGES);

/** Columns needed by summarizeLeads / followUpOverdue / attribution. */
export const LEAD_METRIC_COLUMNS =
  "id,assigned_to,imported_by,source,source_platform,stage,final_status,quotation_value,win_probability,won_at,created_at,updated_at,last_contact_date,next_followup_date,followup_count,lead_status,hold_since,recovery_candidate,transfer_candidate,sales_manager_review,quality,ai_quality";

/** Columns the two ads-attribution pages group and count by. */
export const ADS_ATTRIBUTION_COLUMNS =
  "archived,source,source_platform,campaign_name,utm_campaign,meta_campaign,adset_name,ad_name,stage,final_status,quotation_value,quality";

export function isCountedLead(lead) {
  return Boolean(lead) && lead.archived !== true;
}

export function leadOutcome(lead) {
  return lead?.final_status || lead?.stage || null;
}

export function isActiveLead(lead) {
  if (!isCountedLead(lead)) return false;
  const outcome = leadOutcome(lead);
  return outcome !== "won" && outcome !== "lost";
}

export function isWonLead(lead) {
  return isCountedLead(lead) && leadOutcome(lead) === "won";
}

export function isLostLead(lead) {
  return isCountedLead(lead) && leadOutcome(lead) === "lost";
}

export function isWonInPeriod(lead, bounds) {
  return isWonLead(lead) && inBounds(lead.won_at, bounds);
}

/** Has the lead reached first contact (any stage past "new", or a logged contact)? */
export function isContactedLead(lead) {
  if (!isCountedLead(lead)) return false;
  if (lead.last_contact_date || (lead.followup_count ?? 0) > 0) return true;
  const outcome = leadOutcome(lead);
  return CONTACTED_STAGES.has(outcome) || outcome === "won";
}

export function isQuotedLead(lead) {
  return isWonLead(lead) || (isActiveLead(lead) && QUOTED.has(lead.stage));
}

export function conversionRate(won, total) {
  return total > 0 ? Math.round((won / total) * 100) : 0;
}

export function percentOf(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** Quality used for reporting: pending | good | normal | bad | unknown. */
export function qualityBucket(lead) {
  const raw = String(lead?.quality || lead?.ai_quality || "").toLowerCase();
  switch (raw) {
    case "pending":
      return "pending";
    case "good":
    case "valid":
    case "hot":
      return "good";
    case "normal":
    case "warm":
      return "normal";
    case "poor":
    case "bad":
    case "cold":
    case "fake":
    case "job_seeker":
    case "duplicate":
      return "bad";
    default:
      return "unknown";
  }
}
export const QUALITY_BUCKETS = Object.freeze(["pending", "good", "normal", "bad", "unknown"]);

/** "Valid" lead for attribution: quality good or normal. */
export function isValidQualityLead(lead) {
  const bucket = qualityBucket({ quality: lead?.quality });
  return bucket === "good" || bucket === "normal";
}

/** Whole Dubai calendar days `due` is late at `now`; 0 when not late. */
export function overdueDays(due, now = new Date()) {
  const days = dubaiDaysBetween(due, now);
  return days === null ? 0 : Math.max(0, days);
}

/**
 * Follow-up overdue state of a lead at `now`:
 * { overdue: false } or { overdue: true, dueAt, days }.
 */
export function followUpOverdue(lead, now = new Date()) {
  if (!isActiveLead(lead)) return { overdue: false };
  const nowMs = new Date(now).getTime();
  if (lead.next_followup_date) {
    // A bare calendar date (a DATE column) is due for the whole of that Dubai day:
    // late only from the next day, and N days late on day N after it.
    if (typeof lead.next_followup_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(lead.next_followup_date)) {
      const late = dubaiDaysBetween(lead.next_followup_date, now);
      return late !== null && late > 0
        ? { overdue: true, dueAt: lead.next_followup_date, days: late }
        : { overdue: false };
    }
    const due = new Date(lead.next_followup_date);
    if (!Number.isNaN(due.getTime()) && due.getTime() < nowMs) {
      return { overdue: true, dueAt: due.toISOString(), days: overdueDays(due, now) };
    }
    return { overdue: false };
  }
  if (!lead.last_contact_date && lead.created_at) {
    const due = new Date(new Date(lead.created_at).getTime() + NEVER_CONTACTED_GRACE_MS);
    if (!Number.isNaN(due.getTime()) && due.getTime() < nowMs) {
      return { overdue: true, dueAt: due.toISOString(), days: overdueDays(due, now) };
    }
  }
  return { overdue: false };
}

/**
 * Counted leads whose follow-up is overdue at `now`, most days late first.
 * Each entry is the lead plus { overdueDays }.
 */
export function overdueLeadList(rows, now = new Date()) {
  const list = [];
  for (const lead of rows || []) {
    const state = followUpOverdue(lead, now);
    if (state.overdue) list.push({ lead, overdueDays: state.days });
  }
  return list.sort((a, b) => b.overdueDays - a.overdueDays);
}

/** Grouping key for "lead source" everywhere (dashboard, analytics, ads pages). */
export function leadSourceKey(lead) {
  return lead?.source || lead?.source_platform || "other";
}

function money(value) {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function emptyAssignee() {
  return {
    total: 0, active: 0, won: 0, lost: 0, contacted: 0,
    wonValue: 0, pipelineValue: 0,
    periodWonCount: 0, periodWonValue: 0,
    imported: 0,
  };
}

/**
 * Aggregate counted leads. `period` (optional) is a Dubai bounds object for the
 * selected month; `now` defaults to the current instant.
 */
export function summarizeLeads(rows, { period = null, now = new Date() } = {}) {
  const nowMs = new Date(now).getTime();
  const stageCounts = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0]));
  const stageValues = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0]));
  const statusCounts = {};
  const bySource = {};
  const byAssignee = {};
  const importedBy = {};
  const s = {
    total: 0, active: 0, won: 0, lost: 0, contacted: 0,
    pipelineValue: 0, weightedPipelineValue: 0,
    newLast7Days: 0,
    periodWonCount: 0, periodWonValue: 0,
    yellowCount: 0, redCount: 0,
    recoveryCount: 0, transferCount: 0, reviewCount: 0,
    highProbStale: 0, pendingStale: 0,
    followUpOverdue: 0,
    dormant: 0, zeroFollowup: 0,
  };
  const qualityBreakdown = Object.fromEntries(QUALITY_BUCKETS.map((k) => [k, 0]));

  for (const lead of rows || []) {
    if (!isCountedLead(lead)) continue;
    if (lead.imported_by) importedBy[lead.imported_by] = (importedBy[lead.imported_by] || 0) + 1;
    const value = money(lead.quotation_value);
    const outcome = leadOutcome(lead);
    const won = outcome === "won";
    const lost = outcome === "lost";
    const active = outcome !== "won" && outcome !== "lost";
    const periodWon = won && period ? inBounds(lead.won_at, period) : false;
    const contacted = isContactedLead(lead);

    s.total++;
    if (outcome && stageCounts[outcome] !== undefined) {
      stageCounts[outcome]++;
      stageValues[outcome] += value;
    }
    const status = lead.lead_status || "unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (won) s.won++;
    if (lost) s.lost++;
    if (contacted) s.contacted++;
    if (periodWon) { s.periodWonCount++; s.periodWonValue += value; }
    if (lead.created_at && nowMs - new Date(lead.created_at).getTime() < 7 * 24 * 3600 * 1000) s.newLast7Days++;
    qualityBreakdown[qualityBucket(lead)]++;
    if (!lead.followup_count || !lead.last_contact_date) s.zeroFollowup++;
    {
      const sinceContact = dubaiDaysBetween(lead.last_contact_date, now);
      if (lead.lead_status === "dormant" || (active && sinceContact !== null && sinceContact >= STALE_RED_DAYS)) s.dormant++;
    }

    if (active) {
      s.active++;
      s.pipelineValue += value;
      s.weightedPipelineValue += (value * (lead.win_probability || 0)) / 100;
      const staleDays = dubaiDaysBetween(lead.last_contact_date || lead.updated_at, now);
      if (staleDays !== null && staleDays >= STALE_RED_DAYS) s.redCount++;
      else if (staleDays !== null && staleDays >= STALE_YELLOW_DAYS) s.yellowCount++;
      if (lead.recovery_candidate) s.recoveryCount++;
      if (lead.transfer_candidate) s.transferCount++;
      if (lead.sales_manager_review) s.reviewCount++;
      if ((lead.win_probability || 0) >= 70 && staleDays !== null && staleDays >= STALE_RED_DAYS) s.highProbStale++;
      if (lead.stage === "pending_decision") {
        const held = dubaiDaysBetween(lead.hold_since || lead.updated_at, now);
        if (held !== null && held >= 30) s.pendingStale++;
      }
      if (followUpOverdue(lead, now).overdue) s.followUpOverdue++;
    }

    const src = leadSourceKey(lead);
    if (!bySource[src]) bySource[src] = { total: 0, won: 0, value: 0, pipelineValue: 0 };
    bySource[src].total++;
    if (won) bySource[src].won++;
    bySource[src].value += value;
    if (active) bySource[src].pipelineValue += value;

    if (lead.assigned_to) {
      const a = (byAssignee[lead.assigned_to] ||= emptyAssignee());
      a.total++;
      if (active) { a.active++; a.pipelineValue += value; }
      if (won) { a.won++; a.wonValue += value; }
      if (lost) a.lost++;
      if (contacted) a.contacted++;
      if (periodWon) { a.periodWonCount++; a.periodWonValue += value; }
    }
  }

  for (const [uid, count] of Object.entries(importedBy)) {
    (byAssignee[uid] ||= emptyAssignee()).imported = count;
  }

  return {
    ...s,
    conversionRate: conversionRate(s.won, s.total),
    contactRate: percentOf(s.contacted, s.total),
    stageCounts,
    stageValues,
    statusCounts,
    qualityBreakdown,
    bySource,
    byAssignee,
  };
}

/** Ads attribution aggregate, shared by /ads and /settings/ads. */
export function aggregateAttribution(rows, keyOf = leadSourceKey) {
  const groups = {};
  for (const lead of rows || []) {
    if (!isCountedLead(lead)) continue;
    const key = keyOf(lead);
    if (!groups[key]) groups[key] = { total: 0, valid: 0, quoted: 0, won: 0, value: 0 };
    const g = groups[key];
    g.total++;
    if (isValidQualityLead(lead)) g.valid++;
    const quoted = isQuotedLead(lead);
    if (quoted) g.quoted++;
    if (isWonLead(lead)) g.won++;
    // Only money that is quoted or won, so the amount matches the counts beside it.
    if (quoted) g.value += money(lead.quotation_value);
  }
  return groups;
}

export function totalAttribution(groups) {
  const totals = { total: 0, valid: 0, quoted: 0, won: 0, value: 0 };
  for (const g of Object.values(groups)) {
    totals.total += g.total; totals.valid += g.valid; totals.quoted += g.quoted;
    totals.won += g.won; totals.value += g.value;
  }
  return totals;
}
