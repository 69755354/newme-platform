#!/usr/bin/env node
// Daily: the sales sheet's lead quality / quote outcome -> Meta feedback events (enqueue only).
//   node scripts/sheet-meta-feedback.mjs [--execute] [--max-events N] [--max-lead-age-days N]
// Default is a read-only dry run. --execute enqueues only when SHEET_META_FEEDBACK_ENABLED=true (default off).
// Reads the "Lead Register" with the read-only Sheets key; never writes the sheet; never writes OS lead stage/quality/owner.
// The existing senders (newme-meta-crm-send / newme-wa-capi-send timers) deliver what is queued. Output: aggregate counts only.
import { existsSync, realpathSync as realpathOf } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createSheetsReader } from "./lib/drive-sheets-readonly.mjs";
import { DEFAULTS } from "../src/lib/os-drive-sync.mjs";
import { WA_QUOTE_DELIVERY, attemptCapiDelivery } from "../src/lib/meta-capi-delivery.ts";
import { sendWhatsAppCapiPayload } from "../src/lib/whatsapp-capi.mjs";
import {
  DEFAULT_MAX_EVENTS, DEFAULT_MAX_LEAD_AGE_DAYS, applyPlan, buildLeadIndex, parseRegister, planFeedback, waQuoteOutboxId,
} from "../src/lib/sheet-meta-feedback.mjs";

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const must = (r) => { if (r.error) throw new Error("database read failed"); return r.data ?? []; };

export function parseArgs(argv, env = process.env) {
  const a = { execute: false, maxEvents: Number(env.SHEET_META_FEEDBACK_MAX_EVENTS) || DEFAULT_MAX_EVENTS,
    maxLeadAgeDays: Number(env.SHEET_META_MAX_LEAD_AGE_DAYS) || DEFAULT_MAX_LEAD_AGE_DAYS, unknown: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--execute") a.execute = true;
    else if (argv[i] === "--max-events") a.maxEvents = Number(argv[++i]);
    else if (argv[i] === "--max-lead-age-days") a.maxLeadAgeDays = Number(argv[++i]);
    else a.unknown = argv[i];
  }
  return a;
}

/** Existing queue state for the candidate leads, so a re-run never re-queues (and the dry run counts only what is new). */
export async function loadQueueState(db, leadIds) {
  const existing = { form: new Set(), wa: new Set(), waQuote: new Set() };
  const outbox = new Map(leadIds.map((id) => [waQuoteOutboxId(id), id]));
  for (const ids of chunk(leadIds, 100)) {
    for (const r of must(await db.from("meta_crm_stage_events").select("lead_id, event_name").in("lead_id", ids))) existing.form.add(`${r.lead_id}|${r.event_name}`);
    for (const r of must(await db.from("whatsapp_capi_events").select("lead_id, event_name").in("lead_id", ids))) existing.wa.add(`${r.lead_id}|${r.event_name}`);
    for (const r of must(await db.from("business_events").select("id").in("id", ids.map(waQuoteOutboxId)))) existing.waQuote.add(outbox.get(r.id));
  }
  return existing;
}

export async function loadLeads(db) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await db.from("leads").select("id, meta_leadgen_id, ctwa_clid, created_at, archived, quotation_value")
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function loadWaba(db, leadIds) {
  const ok = new Set();
  for (const ids of chunk(leadIds, 100)) for (const r of must(await db.from("whatsapp_conversations").select("lead_id, waba_id, first_ctwa_clid").in("lead_id", ids))) {
    if (typeof r.waba_id === "string" && /^[0-9]{5,32}$/.test(r.waba_id) && r.first_ctwa_clid) ok.add(r.lead_id);
  }
  return ok;
}

export async function runFeedback({ db, sheetValues, args, env = process.env, nowMs = Date.now(), waQuoteAttempt = null }) {
  const enabled = env.SHEET_META_FEEDBACK_ENABLED === "true";
  const sendLost = env.SHEET_META_FEEDBACK_SEND_LOST !== "false";
  const rows = parseRegister(sheetValues);
  // All leads are indexed (so an old or archived lead is told apart from an unknown id); queue state is read for the recent ones only.
  const leads = await loadLeads(db);
  const index = buildLeadIndex(leads);
  const cutoff = nowMs - args.maxLeadAgeDays * 86_400_000;
  const ids = leads.filter((l) => !l.archived && Date.parse(l.created_at) >= cutoff).map((l) => l.id);
  const [existing, waba] = [await loadQueueState(db, ids), await loadWaba(db, ids)];
  const plan = planFeedback(rows, index, { existing, waba, nowMs, maxEvents: args.maxEvents, maxLeadAgeDays: args.maxLeadAgeDays, sendLost });
  const result = { mode: args.execute && enabled ? "execute" : "dry_run", ...(args.execute && !enabled ? { execute_blocked: "SHEET_META_FEEDBACK_ENABLED is not true" } : {}),
    send_lost: sendLost, would_enqueue_total: plan.total, ...plan.counts };
  if (args.execute && enabled && plan.items.length) result.applied = await applyPlan(db, plan.items, { nowSeconds: Math.floor(nowMs / 1000), waQuoteAttempt });
  return result;
}

const isMainModule = () => { try { return Boolean(process.argv[1]) && realpathOf(process.argv[1]) === realpathOf(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown || !(args.maxEvents >= 1 && args.maxEvents <= 500) || !(args.maxLeadAgeDays >= 1 && args.maxLeadAgeDays <= 90)) {
    console.error("Usage: node scripts/sheet-meta-feedback.mjs [--execute] [--max-events 1-500] [--max-lead-age-days 1-90] (default: read-only dry run)");
    process.exitCode = 2;
  } else {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("database configuration unavailable");
      const saFile = process.env.GOOGLE_SA_FILE || (existsSync("/etc/newme/google-sheets-sa.json") ? "/etc/newme/google-sheets-sa.json" : `${homedir()}/.config/newme/google-sheets-sa.json`);
      const reader = createSheetsReader({ saFile });
      const sheetValues = await reader.getValues(process.env.SHEET_META_FEEDBACK_SHEET_ID || DEFAULTS.registerSheetId, `'${DEFAULTS.registerTab}'!A${DEFAULTS.registerHeaderRow}:AK`);
      const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const waQuoteAttempt = (d, row) => attemptCapiDelivery(d, row, sendWhatsAppCapiPayload, Date.now(), WA_QUOTE_DELIVERY);
      console.log(JSON.stringify(await runFeedback({ db, sheetValues, args, waQuoteAttempt })));
    } catch (e) {
      console.error(`Sheet-to-Meta feedback did not complete: ${String(e?.message ?? "error").slice(0, 120)}`);
      process.exitCode = 1;
    }
  }
}
