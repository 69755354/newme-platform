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

export const UNASSIGNED_LABEL = "未分配";
export const MAX_TEXT_CHARS = 400;
export const UNCONTACTED_AFTER_HOURS = 24;
export const ATTENTION_UNCONTACTED_OVER = 5;
export const NORMAL_CHANNEL_MIN_LEADS = 5; // leads in the 14 days before yesterday that make a channel "normally has leads"
export const REMINDER_FIRST_HOUR = 9;
export const REMINDER_LAST_HOUR = 21; // inclusive: the 21:00 run still goes out
export const DEFAULT_MAX_LEAD_AGE_DAYS = 30;
// S35: ad-sourced leads (Meta form, WhatsApp click-to-chat, website) are chased far sooner than the 24 hour rule.
export const AD_FIRST_CONTACT_MINUTES = 60;
export const AD_REMINDER_THRESHOLD = "1h"; // part of every ledger / event key: one reminder per lead per threshold
export const AD_REMINDER_MAX_AGE_DAYS = 3; // older ad leads belong to the 24 hour reminder and the brief
export const MANAGER_ROLES = Object.freeze(["admin", "boss"]);
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

/** Rows bulk-loaded from the sales sheets (data import gate) are history, not new arrivals or open contact tasks. */
export const isBulkImported = (lead) => Boolean(lead?.imported_at);

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
    if (!isReportableLead(lead, excludedTestIds) || isBulkImported(lead)) continue;
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
  // first_touch_at is the intake time (form received, website submit, first WhatsApp message in): it says the lead arrived,
  // not that anyone contacted the customer, so it is deliberately not contact evidence. wa_first_reply_at is our first reply.
  if (lead.last_contact_date || lead.wa_first_reply_at || lead.no_answer_flag === true) return true;
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
 * assigned_to is null for leads nobody owns in OS; sheet_owner is the name stored by the sheet sync (drive_sync.sheet_owner).
 * @returns {Array<{lead_id, assigned_to, sheet_owner, age_hours, first_name, channel}>} oldest first
 */
export function selectUncontacted({ leads, transfers = [], logLeadIds = new Set(), excludedTestIds = new Set(), now = new Date(),
  afterHours = UNCONTACTED_AFTER_HOURS, maxAgeDays = DEFAULT_MAX_LEAD_AGE_DAYS } = {}) {
  const out = [];
  for (const lead of leads ?? []) {
    // A lead with no OS owner still counts (the sales team works in the Google sheets): the brief must not report a false all-clear.
    if (!isReportableLead(lead, excludedTestIds) || isBulkImported(lead)) continue;
    const outcome = leadOutcome(lead);
    if (outcome === "won" || outcome === "lost" || lead.hold_since) continue;
    if (hasFirstContact(lead, logLeadIds)) continue;
    const created = Date.parse(lead.created_at ?? "");
    if (Number.isFinite(created) && now.getTime() - created > maxAgeDays * DAY) continue;
    const since = assignedAtMs(lead, transfers);
    if (since === null) continue;
    const ageMs = now.getTime() - since;
    if (ageMs <= afterHours * HOUR) continue;
    out.push({ lead_id: lead.id, assigned_to: lead.assigned_to ?? null, sheet_owner: sheetOwnerName(lead), age_hours: Math.floor(ageMs / HOUR),
      first_name: firstName(lead.customer_name), channel: channelOf(lead) });
  }
  return out.sort((a, b) => b.age_hours - a.age_hours);
}

/** Owner name stored by the sheet sync (register "Assigned to" / sales tab owner); "" when unknown. */
export function sheetOwnerName(lead) {
  const sheet = lead?.drive_sync && typeof lead.drive_sync === "object" ? lead.drive_sync : null;
  return text(sheet?.sheet_owner).slice(0, 40);
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

/**
 * Brief grouping of uncontacted leads by who is responsible: the OS profile name, else the sheet owner, else "未分配".
 * Unlike planReminders nobody is dropped (no profile, no phone, system account all still show).
 * @returns {Array<{name, unassigned, items, oldest_hours}>} biggest group first, the unassigned group last on ties
 */
export function groupUncontactedForBrief(uncontacted, profiles = []) {
  const byId = new Map((profiles ?? []).filter((p) => !isSystemAccount(p)).map((p) => [p.id, p]));
  const groups = new Map();
  for (const item of uncontacted ?? []) {
    const osName = item.assigned_to ? text(byId.get(item.assigned_to)?.full_name) : "";
    const name = osName || text(item.sheet_owner) || UNASSIGNED_LABEL;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups].map(([name, items]) => ({ name, unassigned: name === UNASSIGNED_LABEL, items,
    oldest_hours: Math.max(...items.map((i) => i.age_hours)) }))
    .sort((a, b) => b.items.length - a.items.length || Number(a.unassigned) - Number(b.unassigned) || b.oldest_hours - a.oldest_hours);
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
export function buildBrief({ dateKey, leads, people = [], groups = null, missingPhone = [], quotes, spend }) {
  const channels = CHANNELS.map((c) => `${channelLabel(c)}${leads.byChannel[c]}`).join(" ");
  // groups (groupUncontactedForBrief) cover every uncontacted lead; people (planReminders) only those with a known salesperson.
  const shownGroups = groups ?? people.map((p) => ({ name: p.name, unassigned: false, items: p.items, oldest_hours: p.oldest_hours }));
  const uncontactedTotal = shownGroups.reduce((s, p) => s + p.items.length, 0);
  const unassignedCount = shownGroups.filter((g) => g.unassigned).reduce((s, g) => s + g.items.length, 0);
  const attention = [];
  if (unassignedCount > 0) attention.push(`未分配${unassignedCount}条无人认领`);
  if (uncontactedTotal > ATTENTION_UNCONTACTED_OVER) attention.push(`未联系共${uncontactedTotal}条`);
  const silent = NORMAL_CHANNELS.filter((c) => leads.byChannel[c] === 0 && leads.prior[c] >= NORMAL_CHANNEL_MIN_LEADS).map(channelLabel);
  if (silent.length) attention.push(`${silent.join("、")}昨日0条线索`);
  if (missingPhone.length) attention.push(`${missingPhone.map((p) => p.name).join("、")}无手机号，提醒未发`);

  const build = (shown) => {
    // The unassigned group is always spelled out, even when the list is cut short.
    const named = shownGroups.filter((g) => !g.unassigned), open = shownGroups.filter((g) => g.unassigned);
    const kept = [...named.slice(0, Math.max(0, shown - open.length)), ...open];
    const rest = shownGroups.length - kept.length;
    const who = shownGroups.length
      ? `${kept.map((p) => `${p.name}${p.items.length}条(最久${ageLabel(p.oldest_hours)})`).join("、")}${rest > 0 ? `等${shownGroups.length}人` : ""}`
      : "无";
    const parts = [`${dateKey}日报`, `新线索${leads.total}条（${channels}）`, `24小时未联系：${who}`, `昨日报价${quotes.count}单，合计AED ${money(quotes.total)}`];
    if (spend) parts.push(`广告花费AED ${money(spend.spend)}${spend.cpl === null ? "" : `，单条线索AED ${money(spend.cpl)}`}`);
    if (attention.length) parts.push(`需要注意：${attention.join("；")}`);
    return parts.join("；");
  };
  for (let shown = shownGroups.length; shown >= 3; shown -= 1) {
    const candidate = build(shown);
    if ([...candidate].length <= MAX_TEXT_CHARS) return candidate;
  }
  return clip(build(Math.min(3, shownGroups.length)));
}

/** One reminder for one salesperson: count plus customer first name, channel and age (at most five lines of detail). */
export function buildReminder(person) {
  const shown = person.items.slice(0, 5).map((i) => `${i.first_name}·${channelLabel(i.channel)}·${ageLabel(i.age_hours)}`);
  const more = person.items.length > shown.length ? `等共${person.items.length}条` : "";
  return clip(`${person.name}，您有${person.items.length}条线索分配超24小时仍未记录首次联系：${shown.join("，")}${more}。请尽快联系，并在OS里记录首次联系。`);
}

const isAdSourced = (lead) => isAdLead(lead) || text(lead?.source).toLowerCase() === "website"
  || ["meta_lead_form", "whatsapp_ctwa"].includes(text(lead?.source_channel));

/**
 * When an ad lead that arrived at `intakeMs` must have been contacted by (epoch ms). Dubai working hours are
 * 09:00-21:00: a lead arriving 09:00-20:00 is due one hour later; anything else (evening, night, early morning)
 * is due at 10:00 Dubai, the same day when it arrived before 09:00, else the next day.
 */
export function adFirstContactDueMs(intakeMs) {
  const local = intakeMs + 4 * HOUR; // Dubai wall clock read through the UTC fields
  const minutes = new Date(local).getUTCHours() * 60 + new Date(local).getUTCMinutes();
  if (minutes >= REMINDER_FIRST_HOUR * 60 && minutes <= (REMINDER_LAST_HOUR - 1) * 60) return intakeMs + AD_FIRST_CONTACT_MINUTES * 60_000;
  const dayStartLocal = Math.floor(local / DAY) * DAY; // Dubai midnight, in shifted time
  const tenToday = dayStartLocal + 10 * HOUR;
  const dueLocal = minutes < REMINDER_FIRST_HOUR * 60 ? tenToday : tenToday + DAY;
  return dueLocal - 4 * HOUR;
}

/**
 * Ad-sourced leads past their first-contact deadline with no recorded contact, assigned or not.
 * Test records, archived, held, closed, bulk-imported and old (AD_REMINDER_MAX_AGE_DAYS) leads are left out.
 * @returns {Array<{lead_id, assigned_to, first_name, channel, overdue_minutes}>} longest waiting first
 */
export function selectAdUncontacted({ leads, logLeadIds = new Set(), excludedTestIds = new Set(), now = new Date(),
  maxAgeDays = AD_REMINDER_MAX_AGE_DAYS } = {}) {
  const out = [];
  for (const lead of leads ?? []) {
    if (!isReportableLead(lead, excludedTestIds) || isBulkImported(lead) || !isAdSourced(lead)) continue;
    const outcome = leadOutcome(lead);
    if (outcome === "won" || outcome === "lost" || lead.hold_since) continue;
    if (hasFirstContact(lead, logLeadIds)) continue;
    const created = Date.parse(lead.created_at ?? "");
    if (!Number.isFinite(created) || now.getTime() - created > maxAgeDays * DAY) continue;
    const due = adFirstContactDueMs(created);
    if (now.getTime() < due) continue;
    out.push({ lead_id: lead.id, assigned_to: lead.assigned_to ?? null, first_name: firstName(lead.customer_name),
      channel: channelOf(lead), overdue_minutes: Math.floor((now.getTime() - due) / 60_000) });
  }
  return out.sort((a, b) => b.overdue_minutes - a.overdue_minutes);
}

/**
 * Who hears about each overdue ad lead: its active owner; a lead with no usable owner (none, inactive, system account)
 * goes to every active admin and boss. Items already reminded (`done` keys "<person id>:<lead id>") are dropped, so each
 * lead is reminded once per person per threshold.
 * @returns {{people: Array<{id, name, role, manager, items, number}>, sendable, missingPhone}}
 */
export function planAdReminders(items, profiles, done = new Set()) {
  const usable = (profiles ?? []).filter((p) => p?.is_active !== false && !isSystemAccount(p));
  const byId = new Map(usable.map((p) => [p.id, p]));
  const managers = usable.filter((p) => MANAGER_ROLES.includes(p.role));
  const groups = new Map();
  const add = (person, item) => {
    if (done.has(`${person.id}:${item.lead_id}`)) return;
    if (!groups.has(person.id)) groups.set(person.id, []);
    groups.get(person.id).push(item);
  };
  for (const item of items) {
    const owner = item.assigned_to ? byId.get(item.assigned_to) : null;
    if (owner) add(owner, { ...item, unassigned: false });
    else for (const manager of managers) add(manager, { ...item, unassigned: true });
  }
  const people = [...groups].map(([id, list]) => {
    const p = byId.get(id);
    const phone = normalizePhone(p.phone);
    return { id, name: text(p.full_name) || "同事", role: p.role, manager: MANAGER_ROLES.includes(p.role) && list.every((i) => i.unassigned),
      items: list, number: phone.ok ? phone.e164.replace(/^\+/, "") : null };
  }).sort((a, b) => b.items.length - a.items.length);
  return { people, sendable: people.filter((p) => p.number), missingPhone: people.filter((p) => !p.number) };
}

/** One WhatsApp text for the ad-lead reminder (owner or manager version), at most 400 characters. */
export function buildAdReminder(person) {
  const shown = person.items.slice(0, 5).map((i) => `${i.first_name}·${channelLabel(i.channel)}·超时${ageLabel(Math.max(1, Math.ceil(i.overdue_minutes / 60)))}`);
  const more = person.items.length > shown.length ? `等共${person.items.length}条` : "";
  const text_ = person.manager
    ? `${person.name}，有${person.items.length}条广告线索未分配且超1小时无人联系：${shown.join("，")}${more}。未分配，请尽快安排跟进。`
    : `${person.name}，您有${person.items.length}条广告线索超1小时未联系：${shown.join("，")}${more}。请尽快联系，并在OS里记录首次联系。`;
  return clip(text_);
}

/** In-app bell rows for the same reminder (one per person and lead; the event key makes a repeat a no-op). */
export function adReminderNotificationRows(person) {
  return person.items.map((item) => ({
    user_id: person.id,
    type: "follow_up_overdue",
    title: `Lead not contacted yet: ${item.first_name}`,
    body: `Lead "${item.first_name}" has had no first contact for over 1 hour`,
    related_id: item.lead_id,
    related_type: "lead",
    event_key: `lead_uncontacted_${AD_REMINDER_THRESHOLD}:${item.lead_id}`,
  }));
}

/** Is `now` inside the reminder window (Dubai 09:00 through the 21:00 run)? */
export function inReminderWindow(now = new Date()) {
  const hour = new Date(now.getTime() + 4 * HOUR).getUTCHours();
  return hour >= REMINDER_FIRST_HOUR && hour <= REMINDER_LAST_HOUR;
}
