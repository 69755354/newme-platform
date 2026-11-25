#!/usr/bin/env node
// Speed-to-lead for new Meta instant-form leads. Default is a DRY RUN: reads the database, prints counts only, sends and writes nothing.
// Scheduled with --execute every 5 minutes by infra/systemd/newme-speed-to-lead.timer (installed, never enabled by the installer);
// with --execute it still does nothing unless the switch is "true":
//   NEWME_SPEED_TO_LEAD_ENABLED=true   (default off) for each new form lead of the last 2 hours, once per lead:
//     1. WhatsApp template "newme_enquiry_ack" (en) to the customer from the company number
//        (CUSTOMER_WA_ACCESS_TOKEN + CUSTOMER_WA_PHONE_NUMBER_ID from /etc/newme/customer-wa.env; without the token this step is skipped);
//     2. WhatsApp alert to the assigned salesperson (profiles.phone) through the alert sender; when nobody owns the lead, to the
//        default alert recipients (Sam + Tanya). The alert carries property type and area only, never the customer's name or phone.
// Ledger (lead ids and counters only, no customer data): <state dir>/ledger.json. Usage: node scripts/speed-to-lead.mjs [--execute]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchAllRows } from "../src/lib/fetch-all-rows.mjs";
import { sendWhatsapp } from "./daily-brief.mjs";
import {
  ALERT_KEY, MAX_LEAD_AGE_MS, MAX_TRIES, buildSalesAlert, buildTemplateMessage, customerNumber, keys, ownerOf, selectFormLeads, settled,
} from "../src/lib/speed-to-lead.mjs";

const DEFAULT_PHONE_NUMBER_ID = "1322723804261987"; // company WABA number
const LEAD_COLUMNS = "id,customer_name,phone,source,source_channel,created_at,assigned_to,archived,stage,final_status,hold_since,imported_at,property_type,area,location";
// Test records and leads held or closed by a duplicate decision are never contacted (the dispatch function records these
// states without archiving the lead).
export const BLOCKED_DISPATCH_STATUSES = Object.freeze(["excluded_test", "duplicate_review", "duplicate_not_dispatched"]);
const isTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";
const stateDir = (env) => env.NEWME_SPEED_STATE_DIR || "/var/lib/newme-speed-to-lead";
const KEEP_MS = 3 * 86_400_000;

function readLedger(dir) { try { return JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")); } catch { return {}; } }
function writeLedger(dir, ledger, now) {
  for (const [k, v] of Object.entries(ledger)) if (now.getTime() - Date.parse(v.at) > KEEP_MS) delete ledger[k];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `ledger.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
  renameSync(tmp, join(dir, "ledger.json"));
}

/** Sends one template through the Graph API. ok: delivered to Meta; ambiguous: no answer (do not retry, it may have gone out). */
export async function sendTemplate({ body, env = process.env, fetchImpl = fetch }) {
  const token = env.CUSTOMER_WA_ACCESS_TOKEN;
  const phoneId = env.CUSTOMER_WA_PHONE_NUMBER_ID || DEFAULT_PHONE_NUMBER_ID;
  if (!token) return { ok: false, ambiguous: false, skipped: true };
  const version = env.META_GRAPH_API_VERSION || "v25.0";
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    return { ok: res.ok, ambiguous: false };
  } catch { return { ok: false, ambiguous: true }; }
}

export async function loadData(db, now) {
  const since = new Date(now.getTime() - MAX_LEAD_AGE_MS).toISOString();
  const leads = await fetchAllRows((from, to, withCount) => db.from("leads").select(LEAD_COLUMNS, withCount ? { count: "exact" } : undefined)
    .eq("archived", false).eq("source_channel", "meta_lead_form").or("source.is.null,source.neq.synthetic_qa").gte("created_at", since).order("id").range(from, to));
  if (leads.error) throw new Error("leads unavailable");
  const excluded = await fetchAllRows((from, to, withCount) => db.from("lead_dispatch_state").select("lead_id", withCount ? { count: "exact" } : undefined)
    .in("status", BLOCKED_DISPATCH_STATUSES).order("lead_id").range(from, to));
  if (excluded.error) throw new Error("dispatch state unavailable");
  const profiles = await db.from("profiles").select("id,full_name,phone,email,role,is_active").eq("is_active", true);
  if (profiles.error) throw new Error("profiles unavailable");
  return { leads: leads.data, excludedTestIds: new Set(excluded.data.map((r) => r.lead_id)), profiles: profiles.data ?? [] };
}

export async function runSpeedToLead(db, { execute = false, now = new Date(), send = sendWhatsapp, sendCustomer = sendTemplate, env = process.env } = {}) {
  // Switch first: a switched-off timer run must not read the database (a read error would fail the unit and fire the unit alert).
  if (execute && !isTrue(env.NEWME_SPEED_TO_LEAD_ENABLED)) return { job: "speed-to-lead", mode: "disabled", ack_sent: 0, alert_sent: 0, failed: 0 };
  const data = await loadData(db, now);
  const dir = stateDir(env);
  const ledger = readLedger(dir);
  // An in-flight record (written before Meta is contacted) that was never settled means the run was interrupted mid-send: the
  // message may have gone out, so it is never sent again.
  const open = (key) => !ledger[key]?.done && !ledger[key]?.inflight && (ledger[key]?.tries ?? 0) < MAX_TRIES;
  const summary = { job: "speed-to-lead", mode: execute ? "execute" : "dry_run", candidates: 0, waiting_for_owner: 0, ack_due: 0, ack_skipped_bad_number: 0, ack_skipped_no_credentials: 0,
    alert_due: 0, ack_inflight_unsettled: Object.values(ledger).filter((e) => e?.inflight && !e?.done).length, ack_sent: 0, alert_sent: 0, failed: 0 };
  const hasToken = Boolean(env.CUSTOMER_WA_ACCESS_TOKEN);
  const work = [];
  for (const lead of selectFormLeads(data.leads, { now, excludedTestIds: data.excludedTestIds })) {
    summary.candidates += 1;
    const owner = ownerOf(lead, data.profiles);
    if (!settled(lead, owner)) { summary.waiting_for_owner += 1; continue; }
    const k = keys(lead);
    const number = customerNumber(lead.phone);
    const ackOpen = open(k.ack);
    if (ackOpen && !number) summary.ack_skipped_bad_number += 1;
    if (ackOpen && number && !hasToken) summary.ack_skipped_no_credentials += 1;
    const ack = ackOpen && Boolean(number) && (hasToken || !execute);
    const alertKey = owner?.number ? k.owner : k.unassigned;
    const alert = open(alertKey);
    if (ack) summary.ack_due += 1;
    if (alert) summary.alert_due += 1;
    work.push({ lead, owner, number, ack, ackKey: k.ack, alert, alertKey, unassigned: !owner?.number });
  }
  if (!execute) return summary;
  const record = (key, patch) => { ledger[key] = { at: ledger[key]?.at ?? now.toISOString(), tries: 0, ...ledger[key], ...patch }; writeLedger(dir, ledger, now); };
  for (const w of work) {
    if (w.alert) {
      try {
        record(w.alertKey, { tries: (ledger[w.alertKey]?.tries ?? 0) + 1 }); // write-then-send: a failed write sends nothing
        if (await send({ key: ALERT_KEY, text: buildSalesAlert(w.lead, { unassigned: w.unassigned }), number: w.unassigned ? undefined : w.owner.number })) {
          record(w.alertKey, { done: true }); summary.alert_sent += 1;
        } else summary.failed += 1;
      } catch { summary.failed += 1; }
    }
    if (w.ack && hasToken) {
      try {
        record(w.ackKey, { tries: (ledger[w.ackKey]?.tries ?? 0) + 1, inflight: true }); // persisted BEFORE contacting Meta
        const r = await sendCustomer({ body: buildTemplateMessage(w.lead, w.owner, w.number), env });
        if (r.ok) { record(w.ackKey, { done: true, inflight: false }); summary.ack_sent += 1; }
        else if (r.ambiguous) { record(w.ackKey, { done: true, ambiguous: true, inflight: false }); summary.failed += 1; } // no answer: may have gone out, never sent twice
        else { record(w.ackKey, { inflight: false }); summary.failed += 1; } // a definite refusal: the tries counter allows a retry
      } catch { summary.failed += 1; }
    }
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--execute")) {
    console.error("Usage: node scripts/speed-to-lead.mjs [--execute]  (default: dry run, counts only)");
    process.exitCode = 2;
  } else {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("database configuration unavailable");
      const { createClient } = await import("@supabase/supabase-js");
      const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const summary = await runSpeedToLead(db, { execute: args.includes("--execute") });
      console.log(JSON.stringify(summary)); // counts only
      if (summary.failed) process.exitCode = 1;
    } catch (error) {
      console.error(`speed-to-lead did not complete: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
      process.exitCode = 1;
    }
  }
}
