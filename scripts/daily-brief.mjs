#!/usr/bin/env node
// Daily WhatsApp brief and uncontacted-lead reminders. Default is a DRY RUN: reads the database, prints counts only,
// sends nothing and writes nothing. Scheduled with --execute by infra/systemd/newme-daily-brief.timer and
// newme-lead-reminder.timer; with --execute each job still does nothing unless its switch is "true":
//   NEWME_DAILY_BRIEF_ENABLED=true     08:05 Dubai brief to the alert recipients (Sam + Tanya)
//   NEWME_BRIEF_FEEDBACK_SECTION_ENABLED=true  (default off) adds to the brief, per salesperson: leads assigned 1+ day ago whose Day 1 feedback
//                                      is still empty, and leads assigned 3+ days ago whose newest feedback is only a "no answer" note, with the oldest
//                                      lead refs. Read from the Lead Register and the sales sheets with the service account; names, counts and refs only.
//                                      A failed sheet read drops the section; the brief still goes out.
//   NEWME_LEAD_REMINDER_ENABLED=true   hourly 09:00-21:00 Dubai reminders (profiles.phone): (1) each salesperson with leads assigned
//                                      over 24h ago and not contacted; (2) S35 ad leads (Meta form, WhatsApp click-to-chat, website)
//                                      not contacted within 1 hour (outside 09:00-20:00 arrival: by 10:00), to the owner, or when
//                                      nobody owns the lead to every active admin and boss (bell only; WhatsApp too with
//                                      NEWME_AD_LEAD_REMINDER_ADMIN_WHATSAPP=true). Switch: NEWME_AD_LEAD_REMINDER_ENABLED=true
//                                      (default off, independent of the 24 hour switch). Once per lead and person.
//   NEWME_WA_WAIT_ALERT_ENABLED=true   (S40, default off) in the same hourly run: ONE WhatsApp alert to the alert recipients (Sam + Tanya)
//                                      when a customer message on a company WhatsApp channel has had no reply for
//                                      NEWME_WA_WAIT_ALERT_HOURS working hours (default 2, 09:00-21:00 Dubai, Monday to Friday).
//                                      Once per conversation per waiting episode; names and counts only, never customer phones.
// Messages use the existing alert sender and its approved template; credentials stay in /etc/newme/alerts.env.
// Usage: node scripts/daily-brief.mjs --mode brief|reminders [--execute]
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dubaiDateKey } from "../src/lib/dubai-time.mjs";
import { fetchAllRows } from "../src/lib/fetch-all-rows.mjs";
import { FEEDBACK_REGISTER, FEEDBACK_SALES_TABS, summarizeFeedbackBacklog } from "../src/lib/sales-feedback-brief.mjs";
import {
  adReminderNotificationRows, buildAdReminder, buildBrief, buildReminder, countNewLeads, planAdReminders, selectAdUncontacted, groupUncontactedForBrief, inReminderWindow, planReminders, selectUncontacted, summarizeQuotes,
  summarizeSpend, yesterdayBounds, DEFAULT_MAX_LEAD_AGE_DAYS,
} from "../src/lib/daily-brief.mjs";

import {
  WAIT_ALERT_KEY, WAIT_ALERT_MAX_AGE_DAYS, buildWaitAlert, channelOwnerMap, isUnanswered, planWaitAlert, resolveWaitAlertHours, salesFollowedUpSince, selectWaiting, summarizeFollowupWaits,
} from "../src/lib/wa-wait.mjs";

const SENDER = process.env.NEWME_ALERT_SENDER || "/usr/local/libexec/newme/newme-whatsapp-alert.sh";
const stateDir = () => process.env.NEWME_BRIEF_STATE_DIR || "/var/lib/newme-daily-brief";
const CHUNK = 150;
const LEAD_COLUMNS = "id,customer_name,source,source_platform,source_channel,utm_source,ctwa_clid,ad_id,fbclid,meta_click_id,archived,created_at,assigned_to,stage,final_status,hold_since,"
  + "last_contact_date,first_touch_at,wa_first_reply_at,no_answer_flag,followup_count,quotation_value,quotation_sent_date,imported_at,drive_sync:raw_import_data->drive_sync";
const isTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";
const must = (r) => { if (r.error) throw new Error(r.error.message ?? "query failed"); return r.data ?? []; };

async function inChunks(ids, read) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...must(await read(ids.slice(i, i + CHUNK))));
  return out;
}

/** Every row of a paged query (PostgREST caps one answer at 1000 rows); build(from, to, withCount) returns a fresh ordered query. */
async function readAll(build) {
  const r = await fetchAllRows(build);
  if (r.error) throw new Error(r.error.message ?? "query failed");
  return r.data;
}
/** inChunks, but each chunk is read in full pages: a chunk of leads can own more than 1000 log or transfer rows. */
async function inChunksAll(ids, build) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    out.push(...await readAll((from, to, withCount) => build(part, withCount).range(from, to)));
  }
  return out;
}

/** Everything both jobs need, read-only. */
export async function loadData(db, now) {
  const y = yesterdayBounds(now);
  const maxAge = Number(process.env.NEWME_BRIEF_MAX_LEAD_AGE_DAYS) || DEFAULT_MAX_LEAD_AGE_DAYS;
  const since = new Date(Math.min(y.start.getTime() - 15 * 86_400_000, now.getTime() - maxAge * 86_400_000)).toISOString();
  const excluded = await readAll((from, to, withCount) => db.from("lead_dispatch_state").select("lead_id", withCount ? { count: "exact" } : undefined)
    .eq("status", "excluded_test").order("lead_id").range(from, to));
  const excludedTestIds = new Set(excluded.map((r) => r.lead_id));
  const all = await fetchAllRows((from, to, withCount) => db.from("leads").select(LEAD_COLUMNS, withCount ? { count: "exact" } : undefined)
    .eq("archived", false).or("source.is.null,source.neq.synthetic_qa").gte("created_at", since).order("id").range(from, to));
  if (all.error) throw new Error("leads unavailable");
  const leads = all.data;
  // Leads with no OS owner stay in: the sales team works in the sheets, and the brief must show them (reminders skip them later).
  const candidates = leads.filter((l) => l.stage === "new" || l.stage === null);
  const ids = candidates.map((l) => l.id);
  // A note-only log (contact_type "note", e.g. the intake note written when a lead is created) is not a contact with the customer.
  const logs = await inChunksAll(ids, (part, withCount) => db.from("follow_up_logs").select("id,lead_id", withCount ? { count: "exact" } : undefined)
    .in("lead_id", part).or("contact_type.is.null,contact_type.neq.note").order("id"));
  const transfers = await inChunksAll(ids, (part, withCount) => db.from("transfer_history").select("id,lead_id,to_user_id,created_at", withCount ? { count: "exact" } : undefined)
    .in("lead_id", part).order("id"));
  const profiles = must(await db.from("profiles").select("id,full_name,phone,email,role,is_active").eq("is_active", true));
  return { leads, candidates, excludedTestIds, logLeadIds: new Set(logs.map((r) => r.lead_id)), transfers, profiles, y };
}

export function planFrom(data, now) {
  const uncontacted = selectUncontacted({ leads: data.candidates, transfers: data.transfers, logLeadIds: data.logLeadIds,
    excludedTestIds: data.excludedTestIds, now });
  return { ...planReminders(uncontacted, data.profiles), groups: groupUncontactedForBrief(uncontacted, data.profiles) };
}

async function loadBriefExtras(db, data, now) {
  const { y } = data;
  const dayBefore = new Date(y.start.getTime() - 86_400_000).toISOString().slice(0, 10);
  const quotations = await readAll((from, to, withCount) => db.from("quotations").select("id,lead_id,total_amount,currency,status,sent_at,created_at", withCount ? { count: "exact" } : undefined)
    .or(`and(sent_at.gte.${y.start.toISOString()},sent_at.lt.${y.end.toISOString()}),and(sent_at.is.null,created_at.gte.${y.start.toISOString()},created_at.lt.${y.end.toISOString()})`).order("id").range(from, to));
  const quoteLeadIds = [...new Set(quotations.map((q) => q.lead_id))].filter((id) => !data.leads.some((l) => l.id === id));
  const extraLeads = await inChunks(quoteLeadIds, (part) => db.from("leads").select(LEAD_COLUMNS).in("id", part));
  // Sheet-reported quotes: widened by a day on each side, summarizeQuotes keeps only the Dubai day itself.
  const sheet = must(await db.from("leads").select(LEAD_COLUMNS).eq("archived", false).gt("quotation_value", 0)
    .or(`quotation_sent_date.gte.${dayBefore},raw_import_data->drive_sync->>quote_at.gte.${dayBefore}`).limit(2000));
  const leadsById = new Map([...data.leads, ...extraLeads, ...sheet].map((l) => [l.id, l]));
  const spendRows = await readAll((from, to, withCount) => db.from("ad_spend").select("id,spend_date,amount", withCount ? { count: "exact" } : undefined)
    .eq("spend_date", y.key).order("id").range(from, to));
  const waits = await loadFollowupWaits(db, data, now);
  return { quotations, sheetLeads: sheet, leadsById, spendRows, waits };
}

/** First live customer message after our last reply: where the waiting episode of one conversation starts (null: none). */
async function firstLiveInboundAfterReply(db, c) {
  let q = db.from("whatsapp_message_events").select("occurred_at").eq("conversation_id", c.id).eq("direction", "inbound").eq("backfilled", false);
  if (c.last_outbound_at) q = q.gt("occurred_at", c.last_outbound_at);
  const first = must(await q.order("occurred_at", { ascending: true }).limit(1))[0];
  return first ? Date.parse(first.occurred_at) : null;
}

/** S40: customers waiting for a WhatsApp reply, per responsible person (live messages only: the monitor ignores backfilled history). */
export async function loadFollowupWaits(db, data, now) {
  try {
    const states = must(await db.from("lead_followup_state").select("lead_id,state,first_inbound_at,first_reply_at,last_outbound_at").in("state", ["at_risk", "overdue"]).limit(2000));
    if (!states.length) return [];
    const ids = states.map((r) => r.lead_id);
    const leads = await inChunks(ids, (part) => db.from("leads").select("id,assigned_to,archived,final_status,source").in("id", part));
    const conversations = await inChunks(ids, (part) => db.from("whatsapp_conversations").select("id,lead_id,phone_number_id,last_inbound_at,last_outbound_at").in("lead_id", part));
    const channels = must(await db.from("whatsapp_pilot_channels").select("phone_number_id,owner_profile_id,enabled"));
    const waitStarts = new Map();
    for (const c of conversations.filter(isUnanswered).slice(0, 300)) {
      const start = await firstLiveInboundAfterReply(db, c);
      if (start !== null) waitStarts.set(c.lead_id, Math.min(waitStarts.get(c.lead_id) ?? Infinity, start));
    }
    return summarizeFollowupWaits({ states, leads: new Map(leads.map((l) => [l.id, l])), conversations, waitStarts, channelOwners: channelOwnerMap(channels, data.profiles),
      profiles: data.profiles, excludedTestIds: data.excludedTestIds, now });
  } catch { return []; } // the brief goes out without this section rather than not at all
}

/** Reads the Lead Register and the sales tabs (one batch each file) with the Google service account, same file and client as the drive sync. */
async function readFeedbackGrids(env = process.env) {
  const { createSheetsClient, loadServiceAccount } = await import("../src/lib/google-sheets-client.mjs");
  const saFile = env.GOOGLE_SA_FILE || (existsSync("/etc/newme/google-sheets-sa.json") ? "/etc/newme/google-sheets-sa.json" : `${homedir()}/.config/newme/google-sheets-sa.json`);
  const sheets = createSheetsClient({ serviceAccount: loadServiceAccount(saFile), maxRequests: 12 });
  const registerGrid = await sheets.getValues(FEEDBACK_REGISTER.spreadsheetId, `'${FEEDBACK_REGISTER.tab}'!${FEEDBACK_REGISTER.range}`);
  const salesGrids = [];
  for (const t of FEEDBACK_SALES_TABS) salesGrids.push(await sheets.getValues(t.spreadsheetId, `'${t.tab}'!${t.range}`));
  return { registerGrid, salesGrids };
}

/** Sales feedback backlog for the brief; null on any failure (the brief goes out without the section). */
export async function loadFeedbackBacklog({ now, env = process.env, readGrids = readFeedbackGrids } = {}) {
  try {
    const { registerGrid, salesGrids } = await readGrids(env);
    return summarizeFeedbackBacklog(registerGrid, salesGrids, { now });
  } catch { return null; }
}

export function sendWhatsapp({ key, text, number }) {
  const env = { ...process.env };
  if (number) {
    // One salesperson only, and never the ops Telegram chat: a missing WhatsApp delivery is a failure, not a fallback.
    // ALERT_WHATSAPP_ONLY is read by the sender from its process environment before /etc/newme/alerts.env is loaded and
    // cannot be set from that file, so neither a configured Telegram bot nor ALERT_CHANNEL=telegram there can redirect it.
    env.ALERT_WHATSAPP_RECIPIENTS = number;
    env.ALERT_WHATSAPP_ONLY = "1";
    env.ALERT_TELEGRAM_PROVIDER_CONFIG = "/nonexistent/no-telegram-fallback";
    delete env.TELEGRAM_BOT_TOKEN; delete env.TELEGRAM_CHAT_ID; delete env.ALERT_CHANNEL;
  }
  return new Promise((resolve) => execFile(SENDER, [key, "info", text], { env, timeout: 120_000 }, (error) => resolve(!error)));
}

// "Sent today" ledger: only ids and dates, no customer data. Dry runs never touch it.
const ledgerPath = (name, day) => join(stateDir(), `${name}-${day}.json`);
function readLedger(name, day) { try { return JSON.parse(readFileSync(ledgerPath(name, day), "utf8")); } catch { return {}; } }
function writeLedger(name, day, value) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(ledgerPath(name, day), JSON.stringify(value), { mode: 0o600 });
  for (const f of readdirSync(stateDir())) {
    const m = /-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (m && Date.parse(m[1]) < Date.parse(day) - 14 * 86_400_000) rmSync(join(stateDir(), f), { force: true });
  }
}

export async function runBrief(db, { execute = false, now = new Date(), send = sendWhatsapp, env = process.env, readGrids = readFeedbackGrids } = {}) {
  // Switch first: the timer is enabled by the installer, so a switched-off run must not even read the database
  // (a read error would fail the unit and fire newme-unit-alert every day).
  if (execute && !isTrue(env.NEWME_DAILY_BRIEF_ENABLED)) return { job: "brief", mode: "disabled", sent: false };
  const data = await loadData(db, now);
  const extras = await loadBriefExtras(db, data, now);
  const counts = countNewLeads(data.leads, { now, excludedTestIds: data.excludedTestIds });
  const plan = planFrom(data, now);
  const quotes = summarizeQuotes({ quotations: extras.quotations, sheetLeads: extras.sheetLeads, leadsById: extras.leadsById, now, excludedTestIds: data.excludedTestIds });
  const spend = summarizeSpend(extras.spendRows, counts.adLeads, { now });
  const feedback = isTrue(env.NEWME_BRIEF_FEEDBACK_SECTION_ENABLED) ? await loadFeedbackBacklog({ now, env, readGrids }) : null;
  const text = buildBrief({ dateKey: data.y.key, leads: counts, people: plan.people, groups: plan.groups, missingPhone: plan.missingPhone, quotes, spend, waits: extras.waits, feedback });
  const summary = { job: "brief", mode: execute ? "execute" : "dry_run", date: data.y.key, new_leads: counts.total, uncontacted: plan.groups.reduce((s, g) => s + g.items.length, 0), unassigned: plan.groups.filter((g) => g.unassigned).reduce((s, g) => s + g.items.length, 0),
    salespeople_with_uncontacted: plan.people.length, missing_phone: plan.missingPhone.length, quotes: quotes.count, spend_line: Boolean(spend), wa_waiting_people: extras.waits.length, feedback_no_day1: feedback ? feedback.noFeedbackTotal : null, feedback_stale_no_answer: feedback ? feedback.staleTotal : null, chars: [...text].length, sent: false };
  if (!execute) return summary;
  if (!isTrue(env.NEWME_DAILY_BRIEF_ENABLED)) return { ...summary, mode: "disabled" };
  const today = dubaiDateKey(now);
  if (readLedger("brief", today).sent) return { ...summary, mode: "already_sent" };
  if (!(await send({ key: "newme-daily-brief", text }))) throw new Error("brief not delivered");
  writeLedger("brief", today, { sent: true });
  return { ...summary, sent: true };
}

const AD_LEDGER_DAYS = 4; // ad leads older than AD_REMINDER_MAX_AGE_DAYS are never selected, so 4 daily files cover every key
const adLedgerKeys = (now) => {
  const keys = new Set();
  for (let k = 0; k < AD_LEDGER_DAYS; k += 1) {
    for (const key of readLedger("ad-reminders", dubaiDateKey(new Date(now.getTime() - k * 86_400_000))).sent ?? []) keys.add(key);
  }
  return keys;
};

const WA_WAIT_LEDGER_DAYS = WAIT_ALERT_MAX_AGE_DAYS + 1; // an episode older than the max age is never selected, so these files cover every key
const waLedgerKeys = (now) => {
  const keys = new Set();
  for (let k = 0; k < WA_WAIT_LEDGER_DAYS; k += 1) {
    for (const key of readLedger("wa-wait", dubaiDateKey(new Date(now.getTime() - k * 86_400_000))).sent ?? []) keys.add(key);
  }
  return keys;
};

/** S40: read-only part of the daytime escalation: which conversations are due, grouped per responsible person. */
export async function planWaitAlerts(db, data, now, env) {
  const thresholdHours = resolveWaitAlertHours(env.NEWME_WA_WAIT_ALERT_HOURS);
  const since = new Date(now.getTime() - WAIT_ALERT_MAX_AGE_DAYS * 86_400_000).toISOString();
  const channels = must(await db.from("whatsapp_pilot_channels").select("phone_number_id,owner_profile_id,enabled"));
  const channelIds = [...new Set(channels.filter((c) => c.enabled !== false).map((c) => c.phone_number_id))];
  if (!channelIds.length) return { items: [], groups: [], text: "", thresholdHours };
  const rows = must(await db.from("whatsapp_conversations").select("id,lead_id,phone_number_id,last_inbound_at,last_outbound_at")
    .in("phone_number_id", channelIds).gte("last_inbound_at", since).order("last_inbound_at", { ascending: false }).limit(1000));
  // Unanswered, not alerted yet, not closed / archived / test: filtered BEFORE the cap, oldest customer message first.
  const done = waLedgerKeys(now);
  const unanswered = rows.filter((c) => isUnanswered(c) && !done.has(`${c.id}:${c.last_outbound_at ? Date.parse(c.last_outbound_at) : 0}`));
  const leadIds = [...new Set(unanswered.map((c) => c.lead_id).filter(Boolean))];
  const leads = await inChunks(leadIds, (part) => db.from("leads").select("id,assigned_to,archived,final_status,source,last_contact_date").in("id", part));
  const ignored = new Set(leads.filter((l) => l.archived || l.final_status || l.source === "synthetic_qa" || data.excludedTestIds.has(l.id)).map((l) => l.id));
  // S45: the company number cannot see replies from a salesperson's own phone or a call. A lead already followed up in OS after the
  // customer's last message is not "waiting" (follow-up log, contact date, stage moved on).
  const logs = await inChunksAll(leadIds, (part, withCount) => db.from("follow_up_logs").select("id,lead_id,contact_type,no_answer,contact_time,created_at", withCount ? { count: "exact" } : undefined)
    .in("lead_id", part).or("contact_type.is.null,contact_type.neq.note").order("id"));
  const logsByLead = new Map();
  for (const l of logs) logsByLead.set(l.lead_id, [...(logsByLead.get(l.lead_id) ?? []), l]);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  for (const c of unanswered) {
    if (c.lead_id && salesFollowedUpSince(leadById.get(c.lead_id), logsByLead.get(c.lead_id) ?? [], Date.parse(c.last_inbound_at))) ignored.add(c.lead_id);
  }
  const waitStarts = new Map();
  const open = [];
  for (const c of unanswered.filter((x) => !(x.lead_id && ignored.has(x.lead_id))).sort((a, b) => Date.parse(a.last_inbound_at) - Date.parse(b.last_inbound_at))) {
    if (open.length >= 300) break;
    const start = await firstLiveInboundAfterReply(db, c);
    if (start === null) continue; // no live customer message (history only): never an episode, and it does not use the cap
    waitStarts.set(c.id, start);
    open.push(c);
  }
  const items = selectWaiting({ conversations: open, waitStarts, ignoredLeadIds: ignored, done, now, thresholdHours });
  const groups = planWaitAlert(items, { leadAssignee: new Map(leads.map((l) => [l.id, l.assigned_to])), channelOwners: channelOwnerMap(channels, data.profiles), profiles: data.profiles });
  return { items, groups, text: items.length ? buildWaitAlert(groups, thresholdHours) : "", thresholdHours };
}

export async function runReminders(db, { execute = false, now = new Date(), send = sendWhatsapp, env = process.env } = {}) {
  // Switch and window first: a switched-off (or out-of-hours) hourly run does nothing at all, not even a read.
  // Two independent switches (both default off): the 24 hour reminder, and the S35 one-hour ad-lead reminder.
  const reminder24 = isTrue(env.NEWME_LEAD_REMINDER_ENABLED);
  const adReminder = isTrue(env.NEWME_AD_LEAD_REMINDER_ENABLED);
  const adAdminWhatsapp = isTrue(env.NEWME_AD_LEAD_REMINDER_ADMIN_WHATSAPP);
  const waAlert = isTrue(env.NEWME_WA_WAIT_ALERT_ENABLED);
  if (execute && !reminder24 && !adReminder && !waAlert) return { job: "reminders", mode: "disabled", sent: 0, failed: 0 };
  if (execute && !inReminderWindow(now)) return { job: "reminders", mode: "outside_window", sent: 0, failed: 0 };
  const data = await loadData(db, now);
  const plan = planFrom(data, now);
  const today = dubaiDateKey(now);
  const done = new Set(readLedger("reminders", today).sent ?? []);
  const due = plan.sendable.filter((p) => !done.has(p.id));
  // S35: ad leads past their one-hour deadline, owned or not (the 24 hour plan above skips unowned leads on purpose).
  const adItems = selectAdUncontacted({ leads: data.candidates, logLeadIds: data.logLeadIds, excludedTestIds: data.excludedTestIds, now });
  const adDone = adLedgerKeys(now);
  const adPlan = planAdReminders(adItems, data.profiles, adDone);
  const summary = { job: "reminders", mode: execute ? "execute" : "dry_run", date: today, salespeople_with_uncontacted: plan.people.length,
    uncontacted: plan.people.reduce((s, p) => s + p.items.length, 0), missing_phone: plan.missingPhone.length, already_reminded_today: plan.sendable.length - due.length, due: due.length, sent: 0, failed: 0,
    ad_overdue: adItems.length, ad_unassigned: adItems.filter((i) => !i.assigned_to).length, ad_people: adPlan.people.length,
    ad_missing_phone: adPlan.missingPhone.length, ad_sent: 0, ad_failed: 0, ad_bell_failed: 0,
    wa_wait_due: 0, wa_wait_sent: 0, wa_wait_failed: 0 };
  let waPlan = null;
  if (waAlert || !execute) try { waPlan = await planWaitAlerts(db, data, now, env); summary.wa_wait_due = waPlan.items.length; } catch { if (waAlert) summary.wa_wait_failed += 1; }
  if (!execute) return summary;
  if (!inReminderWindow(now)) return { ...summary, mode: "outside_window" };
  for (const person of reminder24 ? due : []) {
    if (await send({ key: "newme-lead-reminder", text: buildReminder(person), number: person.number })) {
      summary.sent += 1; done.add(person.id);
      try { writeLedger("reminders", today, { sent: [...done] }); } catch { summary.failed += 1; } // after each delivery; a failed write never stops the run
    } else summary.failed += 1;
  }
  // S40: one alert for every conversation newly past the wait threshold. Write-then-send: the ids are recorded as pending
  // first (a failed write means nothing is sent, one failure), and taken out again when the delivery fails so the next hour retries.
  if (waAlert && waPlan?.items.length) {
    const keys = waPlan.items.map((i) => i.key);
    let recorded = false;
    try {
      writeLedger("wa-wait", today, { sent: [...new Set([...(readLedger("wa-wait", today).sent ?? []), ...keys])] });
      recorded = true;
    } catch { summary.wa_wait_failed += 1; }
    if (recorded) {
      if (await send({ key: WAIT_ALERT_KEY, text: waPlan.text })) summary.wa_wait_sent = keys.length;
      else {
        summary.wa_wait_failed += 1;
        try { writeLedger("wa-wait", today, { sent: (readLedger("wa-wait", today).sent ?? []).filter((k) => !keys.includes(k)) }); } catch { /* the next run sees the pending ids and skips them: logged as a failure above */ }
      }
    }
  }
  summary.failed += summary.wa_wait_failed;
  // Ad-lead reminders: the bell first (idempotent by event key, also reaches people without a phone number), then WhatsApp.
  // Owners get WhatsApp + bell. Admin/boss for ownerless leads get the bell only (sales still work in the Google sheet, so a
  // WhatsApp to the bosses would nag about a flow that is not theirs) unless NEWME_AD_LEAD_REMINDER_ADMIN_WHATSAPP=true.
  if (!adReminder) return summary;
  for (const person of adPlan.people) {
    const rows = adReminderNotificationRows(person);
    for (let i = 0; i < rows.length; i += 64) { // the database function takes at most 64 rows per call
      try {
        const { error } = await db.rpc("insert_notifications_atomic", { p_notifications: rows.slice(i, i + 64) });
        if (error) throw new Error("bell_failed");
      } catch { summary.ad_bell_failed += 1; }
    }
  }
  const adSent = readLedger("ad-reminders", today).sent ?? [];
  for (const person of adPlan.sendable.filter((p) => !p.manager || adAdminWhatsapp)) {
    if (await send({ key: "newme-lead-reminder", text: buildAdReminder(person), number: person.number })) {
      summary.ad_sent += 1;
      for (const item of person.items) adSent.push(`${person.id}:${item.lead_id}`);
      try { writeLedger("ad-reminders", today, { sent: [...new Set(adSent)] }); } catch { summary.ad_failed += 1; } // after each delivery
    } else summary.ad_failed += 1;
  }
  summary.failed += summary.ad_failed;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const mode = args[args.indexOf("--mode") + 1];
  const unknown = args.filter((a, i) => !(a === "--execute" || a === "--mode" || (i > 0 && args[i - 1] === "--mode")));
  if (!["brief", "reminders"].includes(mode) || unknown.length) {
    console.error("Usage: node scripts/daily-brief.mjs --mode brief|reminders [--execute]  (default: dry run, counts only)");
    process.exitCode = 2;
  } else {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("database configuration unavailable");
      const { createClient } = await import("@supabase/supabase-js");
      const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const run = mode === "brief" ? runBrief : runReminders;
      const summary = await run(db, { execute: args.includes("--execute") });
      console.log(JSON.stringify(summary)); // counts only: no names, phones or lead ids
      if (summary.failed) process.exitCode = 1;
    } catch (error) {
      console.error(`daily-brief ${mode} did not complete: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
      process.exitCode = 1;
    }
  }
}
