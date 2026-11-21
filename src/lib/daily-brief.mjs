// Daily WhatsApp brief (08:05 Dubai) and uncontacted-lead reminders (hourly 09:00-21:00 Dubai).
// Pure selection and wording logic: no network, no database, no clock of its own (every function takes `now`).
// The runner is scripts/daily-brief.mjs. Both jobs are OFF unless their env switch is "true".
//
// Rules shared with the rest of OS:
//   * counted lead   archived = false, source is not synthetic_qa (lead-metrics.mjs) and the dispatch state is not
//                    excluded_test (the administrator's / automatic test-record decision).
//   * first contact  recorded in OS (a follow-up log, last_contact_date, followup_count, first_touch_at, a stage past
//                    "new", the no-answer flag, a WhatsApp reply) OR synced from the sales sheet (drive_sync.first_contact_at
//                    / contact_days_filled, i.e. the sheet's "First contact at" and Day 1 feedback).
//   * assigned at    the newest transfer to the current assignee, else the lead's creation time.
// Messages go out through the existing alert sender, whose template takes one text of at most 400 characters on one line.
import { dubaiDateKey, dubaiDayBounds } from "./dubai-time.mjs";
import { isCountedLead, leadOutcome } from "./lead-metrics.mjs";
import { isAdLead, costPerLead } from "./ads-leads.mjs";
import { isSystemAccount } from "./system-accounts.mjs";
import { normalizePhone } from "./lead-contact.mjs";

export const MAX_TEXT_CHARS = 400;
export const UNCONTACTED_AFTER_HOURS = 24;
export const ATTENTION_UNCONTACTED_OVER = 5;
export const NORMAL_CHANNEL_MIN_LEADS = 5; // leads in the 14 days before yesterday that make a channel "normally has leads"
export const REMINDER_FIRST_HOUR = 9;
export const REMINDER_LAST_HOUR = 21; // inclusive: the 21:00 run still goes out
export const DEFAULT_MAX_LEAD_AGE_DAYS = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const CHANNELS = Object.freeze(["fb_form", "instagram", "whatsapp", "website", "other"]);
const CHANNEL_LABEL = Object.freeze({ fb_form: "FB表单", instagram: "Instagram", whatsapp: "WhatsApp", website: "网站", other: "其他" });
const NORMAL_CHANNELS = Object.freeze(["fb_form", "instagram", "whatsapp", "website"]);
const SOURCE_CHANNEL = Object.freeze({ fb: "fb_form", facebook: "fb_form", meta: "fb_form", ins: "instagram", instagram: "instagram", ig: "instagram", whatsapp: "whatsapp", website: "website" });

const text = (v) => (typeof v === "string" ? v.trim() : "");

/** Brief channel of a lead, from leads.source (the OS value), falling back to source_platform. */
export function channelOf(lead) {
  for (const raw of [lead?.source, lead?.source_platform]) {
    const hit = SOURCE_CHANNEL[text(raw).toLowerCase()];
    if (hit) return hit;
  }
  return "other";
}
export const channelLabel = (channel) => CHANNEL_LABEL[channel] ?? CHANNEL_LABEL.other;

/** Counted lead that is not a test record. excludedTestIds: Set of lead ids whose dispatch state is excluded_test. */
export function isReportableLead(lead, excludedTestIds = new Set()) {
  return isCountedLead(lead) && !excludedTestIds.has(lead.id);
}

/** [start, end) of the Dubai calendar day before `now`, plus its date key. */
export function yesterdayBounds(now = new Date()) {
  const { start, end } = dubaiDayBounds(new Date(now.getTime() - DAY));
  return { start, end, key: dubaiDateKey(start) };
}

const inRange = (value, start, end) => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) && ms >= start.getTime() && ms < end.getTime();
};

/** New leads yesterday per channel, the ad-lead count (for cost per lead) and the channel counts of the 14 days before. */
export function countNewLeads(leads, { now = new Date(), excludedTestIds = new Set() } = {}) {
  const y = yesterdayBounds(now);
  const priorStart = new Date(y.start.getTime() - 14 * DAY);
  const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  const prior = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  let total = 0, adLeads = 0;
  for (const lead of leads ?? []) {
    if (!isReportableLead(lead, excludedTestIds)) continue;
    const channel = channelOf(lead);
    if (inRange(lead.created_at, y.start, y.end)) {
      total += 1; byChannel[channel] += 1;
      if (isAdLead(lead)) adLeads += 1;
    } else if (inRange(lead.created_at, priorStart, y.start)) prior[channel] += 1;
  }
  return { total, byChannel, prior, adLeads };
}

/** Has the lead a recorded first contact, in OS or from the sales sheet? logLeadIds: ids that have a follow-up log. */
export function hasFirstContact(lead, logLeadIds = new Set()) {
  if (!lead) return false;
  if (logLeadIds.has(lead.id)) return true;
  if (lead.last_contact_date || lead.first_touch_at || lead.wa_first_reply_at || lead.no_answer_flag === true) return true;
  if ((lead.followup_count ?? 0) > 0) return true;
  const outcome = leadOutcome(lead);
  if (outcome && outcome !== "new") return true; // any stage past "new" (and won / lost) means contact happened
  const sheet = lead.drive_sync && typeof lead.drive_sync === "object" ? lead.drive_sync : null;
  if (sheet) {
    if (text(sheet.first_contact_at)) return true;
    if (Number(sheet.contact_days_filled) > 0) return true;
  }
  return false;
}

/** When the current assignee got the lead: newest transfer to them, else creation. Epoch ms or null. */
export function assignedAtMs(lead, transfers = []) {
  let best = null;
  for (const t of transfers) {
    if (t?.lead_id !== lead.id || t.to_user_id !== lead.assigned_to) continue;
    const ms = Date.parse(t.created_at ?? "");
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  if (best !== null) return best;
  const created = Date.parse(lead.created_at ?? "");
  return Number.isFinite(created) ? created : null;
}

/**
 * Leads assigned more than `afterHours` ago with no first contact. Test records, archived, held, closed and very old
 * leads (maxAgeDays since creation: stale history is not a reminder) are left out.
 * @returns {Array<{lead_id, assigned_to, age_hours, first_name, channel}>} oldest first
 */
export function selectUncontacted({ leads, transfers = [], logLeadIds = new Set(), excludedTestIds = new Set(), now = new Date(),
  afterHours = UNCONTACTED_AFTER_HOURS, maxAgeDays = DEFAULT_MAX_LEAD_AGE_DAYS } = {}) {
  const out = [];
  for (const lead of leads ?? []) {
    if (!isReportableLead(lead, excludedTestIds) || !lead.assigned_to) continue;
    const outcome = leadOutcome(lead);
    if (outcome === "won" || outcome === "lost" || lead.hold_since) continue;
    if (hasFirstContact(lead, logLeadIds)) continue;
    const created = Date.parse(lead.created_at ?? "");
    if (Number.isFinite(created) && now.getTime() - created > maxAgeDays * DAY) continue;
    const since = assignedAtMs(lead, transfers);
    if (since === null) continue;
    const ageMs = now.getTime() - since;
    if (ageMs <= afterHours * HOUR) continue;
    out.push({ lead_id: lead.id, assigned_to: lead.assigned_to, age_hours: Math.floor(ageMs / HOUR),
      first_name: firstName(lead.customer_name), channel: channelOf(lead) });
  }
  return out.sort((a, b) => b.age_hours - a.age_hours);
}

/** First word of the customer name, letters only and at most 20 characters (never a phone number or e-mail). */
export function firstName(name) {
  const word = text(name).split(/\s+/)[0] ?? "";
  const letters = word.replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 20);
  return letters || "客户";
}

/** Group uncontacted leads per salesperson and split them into reachable and missing-phone. */
export function planReminders(uncontacted, profiles) {
  const byId = new Map((profiles ?? []).filter((p) => !isSystemAccount(p)).map((p) => [p.id, p]));
  const groups = new Map();
  for (const item of uncontacted) {
    if (!byId.has(item.assigned_to)) continue; // unknown or system account: nobody to remind
    if (!groups.has(item.assigned_to)) groups.set(item.assigned_to, []);
    groups.get(item.assigned_to).push(item);
  }
  const people = [...groups].map(([id, items]) => {
    const p = byId.get(id);
    const phone = normalizePhone(p.phone);
    return { id, name: text(p.full_name) || "销售", items, oldest_hours: Math.max(...items.map((i) => i.age_hours)),
      number: phone.ok ? phone.e164.replace(/^\+/, "") : null };
  }).sort((a, b) => b.items.length - a.items.length || b.oldest_hours - a.oldest_hours);
  return { people, sendable: people.filter((p) => p.number), missingPhone: people.filter((p) => !p.number) };
}

const amount = (n) => Number(n);
const positive = (n) => Number.isFinite(amount(n)) && amount(n) > 0;
const aed = (currency) => !text(currency) || text(currency).toUpperCase() === "AED";

/**
 * Quotes with an amount reported on the brief's day, one per lead: an OS quotation (sent_at, else created_at; not
 * draft / rejected / expired) wins over the sheet-reported leads.quotation_value (drive_sync.quote_at or
 * quotation_sent_date on that Dubai day). Only AED amounts are counted.
 */
export function summarizeQuotes({ quotations = [], sheetLeads = [], leadsById = new Map(), now = new Date(), excludedTestIds = new Set() } = {}) {
  const y = yesterdayBounds(now);
  const perLead = new Map();
  const reportable = (leadId) => { const l = leadsById.get(leadId); return Boolean(l) && isReportableLead(l, excludedTestIds); };
  for (const q of quotations) {
    if (["draft", "rejected", "expired"].includes(q?.status) || !reportable(q.lead_id) || !aed(q.currency)) continue;
    if (!inRange(q.sent_at ?? q.created_at, y.start, y.end) || !positive(q.total_amount)) continue;
    perLead.set(q.lead_id, Math.max(perLead.get(q.lead_id) ?? 0, amount(q.total_amount)));
  }
  for (const lead of sheetLeads) {
    if (perLead.has(lead.id) || !isReportableLead(lead, excludedTestIds) || !positive(lead.quotation_value)) continue;
    const day = dubaiDateKey(lead.drive_sync?.quote_at ?? lead.quotation_sent_date ?? "");
    if (day === y.key) perLead.set(lead.id, amount(lead.quotation_value));
  }
  const total = [...perLead.values()].reduce((s, v) => s + v, 0);
  return { count: perLead.size, total: Math.round(total * 100) / 100 };
}

/** Ad spend of the brief's day: null when no row has a known amount (the line is then left out). */
export function summarizeSpend(spendRows, adLeads, { now = new Date() } = {}) {
  const key = yesterdayBounds(now).key;
  let spend = null;
  for (const row of spendRows ?? []) {
    if (String(row?.spend_date ?? "").slice(0, 10) !== key) continue;
    const raw = row.amount;
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) spend = (spend ?? 0) + n;
  }
  if (spend === null) return null;
  return { spend: Math.round(spend * 100) / 100, cpl: costPerLead(spend, adLeads) };
}

const num = (n) => Math.round(n).toLocaleString("en-US");
const money = (n) => (Math.round(n * 100) % 100 === 0 ? num(n) : n.toFixed(2));
export function ageLabel(hours) { return hours >= 48 ? `${Math.floor(hours / 24)}天` : `${hours}小时`; }

/** Clip to the sender's limit by characters (never half a character). */
export function clip(value, max = MAX_TEXT_CHARS) {
  const chars = [...String(value).replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The brief, one line. data: { leads (countNewLeads), people (planReminders().people), missingPhone, quotes, spend }.
 * "需要注意" appears only when something is off.
 */
export function buildBrief({ dateKey, leads, people = [], missingPhone = [], quotes, spend }) {
  const channels = CHANNELS.map((c) => `${channelLabel(c)}${leads.byChannel[c]}`).join(" ");
  const uncontactedTotal = people.reduce((s, p) => s + p.items.length, 0);
  const attention = [];
  if (uncontactedTotal > ATTENTION_UNCONTACTED_OVER) attention.push(`未联系共${uncontactedTotal}条`);
  const silent = NORMAL_CHANNELS.filter((c) => leads.byChannel[c] === 0 && leads.prior[c] >= NORMAL_CHANNEL_MIN_LEADS).map(channelLabel);
  if (silent.length) attention.push(`${silent.join("、")}昨日0条线索`);
  if (missingPhone.length) attention.push(`${missingPhone.map((p) => p.name).join("、")}无手机号，提醒未发`);

  const build = (shown) => {
    const rest = people.length - shown;
    const who = people.length
      ? `${people.slice(0, shown).map((p) => `${p.name}${p.items.length}条(最久${ageLabel(p.oldest_hours)})`).join("、")}${rest > 0 ? `等${people.length}人` : ""}`
      : "无";
    const parts = [`${dateKey}日报`, `新线索${leads.total}条（${channels}）`, `24小时未联系：${who}`, `昨日报价${quotes.count}单，合计AED ${money(quotes.total)}`];
    if (spend) parts.push(`广告花费AED ${money(spend.spend)}${spend.cpl === null ? "" : `，单条线索AED ${money(spend.cpl)}`}`);
    if (attention.length) parts.push(`需要注意：${attention.join("；")}`);
    return parts.join("；");
  };
  for (let shown = people.length; shown >= 3; shown -= 1) {
    const candidate = build(shown);
    if ([...candidate].length <= MAX_TEXT_CHARS) return candidate;
  }
  return clip(build(Math.min(3, people.length)));
}

/** One reminder for one salesperson: count plus customer first name, channel and age (at most five lines of detail). */
export function buildReminder(person) {
  const shown = person.items.slice(0, 5).map((i) => `${i.first_name}·${channelLabel(i.channel)}·${ageLabel(i.age_hours)}`);
  const more = person.items.length > shown.length ? `等共${person.items.length}条` : "";
  return clip(`${person.name}，您有${person.items.length}条线索分配超24小时仍未记录首次联系：${shown.join("，")}${more}。请尽快联系，并在OS里记录首次联系。`);
}

/** Is `now` inside the reminder window (Dubai 09:00 through the 21:00 run)? */
export function inReminderWindow(now = new Date()) {
  const hour = new Date(now.getTime() + 4 * HOUR).getUTCHours();
  return hour >= REMINDER_FIRST_HOUR && hour <= REMINDER_LAST_HOUR;
}
