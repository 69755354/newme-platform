// S40: WhatsApp customer-wait wording and selection for the daily brief and the daytime escalation.
// Pure functions: no network, no database, no clock of its own (every function takes `now`).
//   * brief section   per responsible person: how many conversations are overdue / at risk (lead_followup_state, which
//                     the follow-up monitor computes from live messages only, backfilled = false) and the longest wait.
//   * daytime alert   a customer message on a company WhatsApp channel with no outbound reply for N working hours
//                     (09:00-21:00 Dubai, Monday to Friday) raises ONE alert per conversation per waiting episode.
// Responsible person: the salesperson who owns the channel (whatsapp_pilot_channels.owner_profile_id, only when that
// profile is an operator), else the lead's assignee, else "公司号". Only names are ever written, never customer phones.
import { isWorkingDay } from "./followup-monitor.mjs";
import { isSystemAccount } from "./system-accounts.mjs";

export const COMPANY_NUMBER_LABEL = "公司号";
export const DEFAULT_WAIT_ALERT_HOURS = 2;
export const WAIT_ALERT_FIRST_HOUR = 9;
export const WAIT_ALERT_LAST_HOUR = 21;
export const WAIT_ALERT_MAX_AGE_DAYS = 7; // an older unanswered message is stale history, never alerted
export const WAIT_ALERT_KEY = "newme-wa-wait-alert";
const SALES_ROLES = Object.freeze(["sales", "operator"]); // a salesperson's own number; admin and boss own the shared company number
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DUBAI_OFFSET = 4 * HOUR;
const MAX_TEXT_CHARS = 400;
const text = (v) => (typeof v === "string" ? v.trim() : "");
const ms = (v) => (typeof v === "number" ? v : Date.parse(v));

/** Configured threshold in hours (env value), default 2; anything not a positive number falls back. */
export function resolveWaitAlertHours(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 72 ? n : DEFAULT_WAIT_ALERT_HOURS;
}

/** Milliseconds of 09:00-21:00 Dubai working time (Monday to Friday) between two instants. */
export function businessWaitMs(fromMs, toMs, { firstHour = WAIT_ALERT_FIRST_HOUR, lastHour = WAIT_ALERT_LAST_HOUR } = {}) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let dayStart = Math.floor((fromMs + DUBAI_OFFSET) / DAY) * DAY - DUBAI_OFFSET; // Dubai midnight of the first day
  let total = 0;
  for (let i = 0; i < 45 && dayStart < toMs; i += 1) {
    if (isWorkingDay(dayStart + HOUR)) {
      total += Math.max(0, Math.min(dayStart + lastHour * HOUR, toMs) - Math.max(dayStart + firstHour * HOUR, fromMs));
    }
    dayStart += DAY;
  }
  return total;
}

const hoursLabel = (hours) => (hours >= 48 ? `${Math.floor(hours / 24)}天` : `${hours}小时`);

/**
 * Who answers for a channel: phone_number_id -> { id, name }. Only enabled channels whose owner is an active operator
 * (a salesperson's own number). A channel owned by an administrator or boss is the shared company number: no entry.
 */
export function channelOwnerMap(channels, profiles) {
  const byId = new Map((profiles ?? []).filter((p) => !isSystemAccount(p)).map((p) => [p.id, p]));
  const map = new Map();
  for (const channel of channels ?? []) {
    if (channel?.enabled === false) continue;
    const owner = byId.get(channel?.owner_profile_id);
    if (!owner || !SALES_ROLES.includes(owner.role)) continue;
    map.set(String(channel.phone_number_id), { id: owner.id, name: text(owner.full_name) || "销售" });
  }
  return map;
}

/** Conversations whose newest customer message has no reply after it. */
export const isUnanswered = (c) => {
  const lastIn = ms(c?.last_inbound_at);
  const lastOut = c?.last_outbound_at ? ms(c.last_outbound_at) : -Infinity;
  return Number.isFinite(lastIn) && lastIn > lastOut;
};

/** Channel owner, else the lead's assignee, else the company number label. */
export function responsibleName({ phoneNumberId, assignedTo, channelOwners = new Map(), profiles = [] }) {
  const owner = channelOwners.get(String(phoneNumberId ?? ""));
  if (owner) return owner.name;
  const assignee = assignedTo ? (profiles ?? []).find((p) => p.id === assignedTo && !isSystemAccount(p)) : null;
  return text(assignee?.full_name) || COMPANY_NUMBER_LABEL;
}

/**
 * Brief section: open conversations the follow-up monitor flagged.
 * states: lead_followup_state rows { lead_id, state, first_reply_at, first_inbound_at, last_outbound_at }.
 * leads: Map lead_id -> { assigned_to, archived, final_status, source }. conversations: { lead_id, phone_number_id, last_inbound_at }.
 * @returns {Array<{name, overdue, at_risk, count, longest_hours}>} biggest first
 */
export function summarizeFollowupWaits({ states = [], leads = new Map(), conversations = [], waitStarts = new Map(), channelOwners = new Map(), profiles = [], excludedTestIds = new Set(), now = new Date() } = {}) {
  const nowMs = ms(now);
  const channelByLead = new Map();
  for (const c of conversations) {
    if (!isUnanswered(c)) continue; // the responsible person is the owner of a conversation that is actually waiting
    const seen = channelByLead.get(c.lead_id);
    if (!seen || (ms(c.last_inbound_at) || 0) > seen.at) channelByLead.set(c.lead_id, { at: ms(c.last_inbound_at) || 0, phone: c.phone_number_id });
  }
  // A customer is waiting only while a conversation has a customer message newer than our last reply; a lead whose message was
  // answered can still be "at risk" by the silence rule, which is not the customer waiting.
  const unansweredAt = new Map();
  for (const c of conversations) {
    const lastIn = ms(c.last_inbound_at);
    const lastOut = c.last_outbound_at ? ms(c.last_outbound_at) : -Infinity;
    if (Number.isFinite(lastIn) && lastIn > lastOut) unansweredAt.set(c.lead_id, Math.max(unansweredAt.get(c.lead_id) ?? 0, lastIn));
  }
  const groups = new Map();
  for (const s of states) {
    if (s.state !== "overdue" && s.state !== "at_risk") continue;
    if (!unansweredAt.has(s.lead_id)) continue;
    const lead = leads.get(s.lead_id);
    if (!lead || lead.archived || lead.final_status || lead.source === "synthetic_qa" || excludedTestIds.has(s.lead_id)) continue;
    // The wait starts at the first customer message after our last reply (waitStarts, read from the live events); the same
    // working-hours measure as the alert. Without it, fall back to the stored first message / the newest unanswered one.
    const since = waitStarts.get(s.lead_id) ?? (s.first_reply_at ? unansweredAt.get(s.lead_id) : ms(s.first_inbound_at));
    if (!Number.isFinite(since)) continue;
    const hours = Math.max(0, Math.floor(businessWaitMs(since, nowMs) / HOUR));
    const name = responsibleName({ phoneNumberId: channelByLead.get(s.lead_id)?.phone, assignedTo: lead.assigned_to, channelOwners, profiles });
    const g = groups.get(name) ?? { name, overdue: 0, at_risk: 0, count: 0, longest_hours: 0 };
    if (s.state === "overdue") g.overdue += 1; else g.at_risk += 1;
    g.count += 1;
    g.longest_hours = Math.max(g.longest_hours, hours);
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.longest_hours - a.longest_hours || a.name.localeCompare(b.name));
}

/** One brief fragment: "WhatsApp客户等回复：Ayana 超时1风险1(最久5小时)、…"; "" when nobody waits. At most 3 names. */
export function waitSectionText(waits, maxNames = 3) {
  if (!Array.isArray(waits) || waits.length === 0) return "";
  const part = (g) => `${g.name} ${g.overdue ? `超时${g.overdue}` : ""}${g.at_risk ? `风险${g.at_risk}` : ""}(最久${hoursLabel(g.longest_hours)})`;
  const shown = waits.slice(0, maxNames).map(part).join("、");
  return `WhatsApp客户等回复：${shown}${waits.length > maxNames ? `等${waits.length}人` : ""}`;
}

/**
 * Conversations still waiting for a reply long enough to alert.
 * conversations: { id, lead_id, phone_number_id, last_inbound_at, last_outbound_at }; waitStarts: Map id -> epoch ms of the
 * first live customer message after our last reply (the start of the waiting episode); done: ledger keys already alerted.
 * ignoredLeadIds: closed, archived or test leads.
 */
export function selectWaiting({ conversations = [], waitStarts = new Map(), ignoredLeadIds = new Set(), done = new Set(), now = new Date(), thresholdHours = DEFAULT_WAIT_ALERT_HOURS } = {}) {
  const nowMs = ms(now);
  const out = [];
  for (const c of conversations) {
    const lastIn = ms(c.last_inbound_at);
    const lastOut = c.last_outbound_at ? ms(c.last_outbound_at) : null;
    if (!Number.isFinite(lastIn) || (lastOut !== null && Number.isFinite(lastOut) && lastOut >= lastIn)) continue; // already answered
    if (c.lead_id && ignoredLeadIds.has(c.lead_id)) continue;
    const since = waitStarts.get(c.id);
    if (!Number.isFinite(since) || since < nowMs - WAIT_ALERT_MAX_AGE_DAYS * DAY) continue;
    const waited = businessWaitMs(since, nowMs);
    if (waited <= thresholdHours * HOUR) continue;
    const key = `${c.id}:${lastOut !== null && Number.isFinite(lastOut) ? lastOut : 0}`; // one alert per waiting episode
    if (done.has(key)) continue;
    out.push({ key, conversation_id: c.id, lead_id: c.lead_id ?? null, phone_number_id: c.phone_number_id, waited_hours: Math.floor(waited / HOUR) });
  }
  return out;
}

/**
 * S45: has anyone followed this lead up since the customer's last message? Salespeople mostly answer from their own phone or by
 * call, which the company number never sees, so OS records are the evidence:
 *   * a follow-up log (not a note-only log, not a no-answer attempt) written after the message;
 *   * last_contact_date carrying a real time later than the message. A pure date (midnight) is ignored: the functions that write
 *     notes and logs stamp the day only, and logs are covered exactly by the first rule.
 * Stage and updated_at are deliberately NOT evidence: the system bumps updated_at itself (inbound messages, dispatch, sync).
 * logs: follow_up_logs rows { lead_id, contact_type, no_answer, contact_time, created_at }.
 */
export function salesFollowedUpSince(lead, logs = [], lastInboundMs) {
  if (!lead || !Number.isFinite(lastInboundMs)) return false;
  for (const log of logs) {
    if (log?.contact_type === "note" || log?.no_answer) continue;
    const at = ms(log?.contact_time ?? log?.created_at);
    if (Number.isFinite(at) && at > lastInboundMs) return true;
  }
  const contactMs = lead.last_contact_date ? ms(lead.last_contact_date) : NaN;
  const dateOnly = Number.isFinite(contactMs) && contactMs % DAY === 0;
  return Number.isFinite(contactMs) && !dateOnly && contactMs > lastInboundMs;
}

/** Group alert items per responsible person. */
export function planWaitAlert(items, { leadAssignee = new Map(), channelOwners = new Map(), profiles = [] } = {}) {
  const groups = new Map();
  for (const item of items) {
    const name = responsibleName({ phoneNumberId: item.phone_number_id, assignedTo: item.lead_id ? leadAssignee.get(item.lead_id) : null, channelOwners, profiles });
    const g = groups.get(name) ?? { name, count: 0, longest_hours: 0 };
    g.count += 1;
    g.longest_hours = Math.max(g.longest_hours, item.waited_hours);
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.longest_hours - a.longest_hours || a.name.localeCompare(b.name));
}

/** The alert text, one line, within the sender's limit. Names and counts only. */
export function buildWaitAlert(groups, thresholdHours = DEFAULT_WAIT_ALERT_HOURS) {
  const total = groups.reduce((s, g) => s + g.count, 0);
  const head = `WhatsApp公司号上有${total}位客户已等回复超过${thresholdHours}小时（工作时间）：`;
  const tail = "。公司号上还没有回复，请确认销售是否已用自己手机或电话联系。";
  for (let shown = groups.length; shown >= 1; shown -= 1) {
    const who = groups.slice(0, shown).map((g) => `${g.name} ${g.count}条(最久${hoursLabel(g.longest_hours)})`).join("、");
    const candidate = `${head}${who}${shown < groups.length ? `等${groups.length}人` : ""}${tail}`;
    if ([...candidate].length <= MAX_TEXT_CHARS) return candidate;
  }
  return [...`${head}${groups[0]?.name ?? ""}${tail}`].slice(0, MAX_TEXT_CHARS).join("");
}
