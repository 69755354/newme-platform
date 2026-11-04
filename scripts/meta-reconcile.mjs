#!/usr/bin/env node
// Daily Meta Lead Ads reconciliation (S7 item 2, review 5-logging-monitoring F5):
// compares the Instant Form lead count Meta reports with the leads the CRM holds
// (matched by leadgen id) over the last N days, and exits non-zero when anything
// is missing or could not be checked. READ-ONLY: it reuses the dry-run of the
// pull script, never stores a lead, and prints counts only (no names, contacts,
// form answers or tokens).
//
// Exit codes: 0 consistent, 1 discrepancy or check failure, 2 configuration.
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { pullMetaLeads } from "./meta-leads-pull.mjs";

/** Pure verdict over a dry-run summary. */
export function evaluateReconciliation(summary) {
  const problems = [];
  if (summary.mode !== "dry_run") problems.push("reconciliation must run in dry-run mode");
  if (summary.missing > 0) problems.push(`${summary.missing} Meta lead(s) are not in the CRM`);
  if (summary.failed > 0) problems.push(`${summary.failed} lead(s) could not be checked`);
  const days = Object.entries(summary.by_day ?? {})
    .filter(([, d]) => d.meta !== d.crm_before)
    .map(([day, d]) => ({ day, meta: d.meta, crm: d.crm_before }));
  return { ok: problems.length === 0, problems, days,
    line: problems.length === 0
      ? `Meta ${summary.meta_leads} leads, all present in CRM (isolated test leads: ${summary.isolated ?? 0})`
      : `${problems.join("; ")}. Meta=${summary.meta_leads}, in CRM=${summary.already_in_crm}, differing days: ${days.map((d) => `${d.day} meta ${d.meta} / crm ${d.crm}`).join(", ") || "none"}` };
}

export async function reconcile({ db, fetchImpl = fetch, env, nowMs = Date.now() }) {
  const days = Number(env.RECONCILE_DAYS || 3);
  const graceMinutes = Number(env.RECONCILE_GRACE_MINUTES || 30);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("RECONCILE_DAYS must be 1..30");
  const pageIds = (env.META_LEADGEN_PAGE_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const summary = await pullMetaLeads(db, fetchImpl, {
    version: env.META_GRAPH_API_VERSION || "v22.0", token: env.META_LEADS_ACCESS_TOKEN, pageIds,
    sinceSeconds: Math.floor(nowMs / 1000) - days * 86_400,
    untilSeconds: Math.floor(nowMs / 1000) - graceMinutes * 60,
    execute: false, nowMs,
  });
  return { summary, verdict: evaluateReconciliation(summary) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !env.META_LEADS_ACCESS_TOKEN || !env.META_LEADGEN_PAGE_IDS) {
    console.error("missing configuration: Supabase server credentials, META_LEADS_ACCESS_TOKEN or META_LEADGEN_PAGE_IDS");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { verdict } = await reconcile({ db, env });
    console.log(`${verdict.ok ? "OK" : "MISMATCH"}: ${verdict.line}`);
    process.exit(verdict.ok ? 0 : 1);
  } catch (error) {
    // Only the error code/message of our own thrown codes is printed.
    const code = /^[a-z0-9_]{3,64}$/.test(error?.message ?? "") ? error.message : "reconcile_failed";
    console.log(`CHECK_FAILED: ${code}`);
    process.exit(1);
  }
}
