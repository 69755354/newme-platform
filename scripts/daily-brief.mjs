#!/usr/bin/env node
// Daily WhatsApp brief and uncontacted-lead reminders. Default is a DRY RUN: reads the database, prints counts only,
// sends nothing and writes nothing. Scheduled with --execute by infra/systemd/newme-daily-brief.timer and
// newme-lead-reminder.timer; with --execute each job still does nothing unless its switch is "true":
//   NEWME_DAILY_BRIEF_ENABLED=true     08:05 Dubai brief to the alert recipients (Sam + Tanya)
//   NEWME_LEAD_REMINDER_ENABLED=true   hourly 09:00-21:00 Dubai reminder to each salesperson (profiles.phone)
// Messages use the existing alert sender and its approved template; credentials stay in /etc/newme/alerts.env.
// Usage: node scripts/daily-brief.mjs --mode brief|reminders [--execute]
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dubaiDateKey } from "../src/lib/dubai-time.mjs";
import { fetchAllRows } from "../src/lib/fetch-all-rows.mjs";
import {
  buildBrief, buildReminder, countNewLeads, inReminderWindow, planReminders, selectUncontacted, summarizeQuotes,
  summarizeSpend, yesterdayBounds, DEFAULT_MAX_LEAD_AGE_DAYS,
} from "../src/lib/daily-brief.mjs";

const SENDER = process.env.NEWME_ALERT_SENDER || "/usr/local/libexec/newme/newme-whatsapp-alert.sh";
const stateDir = () => process.env.NEWME_BRIEF_STATE_DIR || "/var/lib/newme-daily-brief";
const CHUNK = 150;
const LEAD_COLUMNS = "id,customer_name,source,source_platform,utm_source,ctwa_clid,ad_id,fbclid,meta_click_id,archived,created_at,assigned_to,stage,final_status,hold_since,"
  + "last_contact_date,first_touch_at,wa_first_reply_at,no_answer_flag,followup_count,quotation_value,quotation_sent_date,drive_sync:raw_import_data->drive_sync";
const isTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";
const must = (r) => { if (r.error) throw new Error(r.error.message ?? "query failed"); return r.data ?? []; };

async function inChunks(ids, read) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...must(await read(ids.slice(i, i + CHUNK))));
  return out;
}

/** Everything both jobs need, read-only. */
export async function loadData(db, now) {
  const y = yesterdayBounds(now);
  const maxAge = Number(process.env.NEWME_BRIEF_MAX_LEAD_AGE_DAYS) || DEFAULT_MAX_LEAD_AGE_DAYS;
  const since = new Date(Math.min(y.start.getTime() - 15 * 86_400_000, now.getTime() - maxAge * 86_400_000)).toISOString();
  const excluded = must(await db.from("lead_dispatch_state").select("lead_id").eq("status", "excluded_test"));
  const excludedTestIds = new Set(excluded.map((r) => r.lead_id));
  const all = await fetchAllRows((from, to, withCount) => db.from("leads").select(LEAD_COLUMNS, withCount ? { count: "exact" } : undefined)
    .eq("archived", false).or("source.is.null,source.neq.synthetic_qa").gte("created_at", since).order("id").range(from, to));
  if (all.error) throw new Error("leads unavailable");
  const leads = all.data;
  const candidates = leads.filter((l) => l.assigned_to && (l.stage === "new" || l.stage === null));
  const ids = candidates.map((l) => l.id);
  const logs = await inChunks(ids, (part) => db.from("follow_up_logs").select("lead_id").in("lead_id", part));
  const transfers = await inChunks(ids, (part) => db.from("transfer_history").select("lead_id,to_user_id,created_at").in("lead_id", part));
  const profiles = must(await db.from("profiles").select("id,full_name,phone,email,role,is_active").eq("is_active", true));
  return { leads, candidates, excludedTestIds, logLeadIds: new Set(logs.map((r) => r.lead_id)), transfers, profiles, y };
}

export function planFrom(data, now) {
  const uncontacted = selectUncontacted({ leads: data.candidates, transfers: data.transfers, logLeadIds: data.logLeadIds,
    excludedTestIds: data.excludedTestIds, now });
  return planReminders(uncontacted, data.profiles);
}

async function loadBriefExtras(db, data, now) {
  const { y } = data;
  const dayBefore = new Date(y.start.getTime() - 86_400_000).toISOString().slice(0, 10);
  const quotations = must(await db.from("quotations").select("lead_id,total_amount,currency,status,sent_at,created_at")
    .or(`and(sent_at.gte.${y.start.toISOString()},sent_at.lt.${y.end.toISOString()}),and(sent_at.is.null,created_at.gte.${y.start.toISOString()},created_at.lt.${y.end.toISOString()})`));
  const quoteLeadIds = [...new Set(quotations.map((q) => q.lead_id))].filter((id) => !data.leads.some((l) => l.id === id));
  const extraLeads = await inChunks(quoteLeadIds, (part) => db.from("leads").select(LEAD_COLUMNS).in("id", part));
  // Sheet-reported quotes: widened by a day on each side, summarizeQuotes keeps only the Dubai day itself.
  const sheet = must(await db.from("leads").select(LEAD_COLUMNS).eq("archived", false).gt("quotation_value", 0)
    .or(`quotation_sent_date.gte.${dayBefore},raw_import_data->drive_sync->>quote_at.gte.${dayBefore}`).limit(2000));
  const leadsById = new Map([...data.leads, ...extraLeads, ...sheet].map((l) => [l.id, l]));
  const spendRows = must(await db.from("ad_spend").select("spend_date,amount").eq("spend_date", y.key));
  return { quotations, sheetLeads: sheet, leadsById, spendRows };
}

function sendWhatsapp({ key, text, number }) {
  const env = { ...process.env };
  if (number) {
    // One salesperson only, and never the ops Telegram chat: a missing WhatsApp delivery is a failure, not a fallback.
    env.ALERT_WHATSAPP_RECIPIENTS = number;
    env.ALERT_TELEGRAM_PROVIDER_CONFIG = "/nonexistent/no-telegram-fallback";
    delete env.TELEGRAM_BOT_TOKEN; delete env.TELEGRAM_CHAT_ID;
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

export async function runBrief(db, { execute = false, now = new Date(), send = sendWhatsapp, env = process.env } = {}) {
  // Switch first: the timer is enabled by the installer, so a switched-off run must not even read the database
  // (a read error would fail the unit and fire newme-unit-alert every day).
  if (execute && !isTrue(env.NEWME_DAILY_BRIEF_ENABLED)) return { job: "brief", mode: "disabled", sent: false };
  const data = await loadData(db, now);
  const extras = await loadBriefExtras(db, data, now);
  const counts = countNewLeads(data.leads, { now, excludedTestIds: data.excludedTestIds });
  const plan = planFrom(data, now);
  const quotes = summarizeQuotes({ quotations: extras.quotations, sheetLeads: extras.sheetLeads, leadsById: extras.leadsById, now, excludedTestIds: data.excludedTestIds });
  const spend = summarizeSpend(extras.spendRows, counts.adLeads, { now });
  const text = buildBrief({ dateKey: data.y.key, leads: counts, people: plan.people, missingPhone: plan.missingPhone, quotes, spend });
  const summary = { job: "brief", mode: execute ? "execute" : "dry_run", date: data.y.key, new_leads: counts.total, uncontacted: plan.people.reduce((s, p) => s + p.items.length, 0),
    salespeople_with_uncontacted: plan.people.length, missing_phone: plan.missingPhone.length, quotes: quotes.count, spend_line: Boolean(spend), chars: [...text].length, sent: false };
  if (!execute) return summary;
  if (!isTrue(env.NEWME_DAILY_BRIEF_ENABLED)) return { ...summary, mode: "disabled" };
  const today = dubaiDateKey(now);
  if (readLedger("brief", today).sent) return { ...summary, mode: "already_sent" };
  if (!(await send({ key: "newme-daily-brief", text }))) throw new Error("brief not delivered");
  writeLedger("brief", today, { sent: true });
  return { ...summary, sent: true };
}

export async function runReminders(db, { execute = false, now = new Date(), send = sendWhatsapp, env = process.env } = {}) {
  // Switch and window first: a switched-off (or out-of-hours) hourly run does nothing at all, not even a read.
  if (execute && !isTrue(env.NEWME_LEAD_REMINDER_ENABLED)) return { job: "reminders", mode: "disabled", sent: 0, failed: 0 };
  if (execute && !inReminderWindow(now)) return { job: "reminders", mode: "outside_window", sent: 0, failed: 0 };
  const data = await loadData(db, now);
  const plan = planFrom(data, now);
  const today = dubaiDateKey(now);
  const done = new Set(readLedger("reminders", today).sent ?? []);
  const due = plan.sendable.filter((p) => !done.has(p.id));
  const summary = { job: "reminders", mode: execute ? "execute" : "dry_run", date: today, salespeople_with_uncontacted: plan.people.length,
    uncontacted: plan.people.reduce((s, p) => s + p.items.length, 0), missing_phone: plan.missingPhone.length, already_reminded_today: plan.sendable.length - due.length, due: due.length, sent: 0, failed: 0 };
  if (!execute) return summary;
  if (!isTrue(env.NEWME_LEAD_REMINDER_ENABLED)) return { ...summary, mode: "disabled" };
  if (!inReminderWindow(now)) return { ...summary, mode: "outside_window" };
  for (const person of due) {
    if (await send({ key: "newme-lead-reminder", text: buildReminder(person), number: person.number })) {
      summary.sent += 1; done.add(person.id);
      writeLedger("reminders", today, { sent: [...done] }); // after each delivery: a crash never double-sends
    } else summary.failed += 1;
  }
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
