#!/usr/bin/env node
// Operator tool, default read-only. Scheduled with --execute by infra/systemd/newme-meta-crm-send.timer.
// Sends queued Meta CRM stage events. Credentials come only from the server environment.
//
// status review_required ("manual" in the Meta IDs export) means the sender parked the event and nothing sends it again:
//   * too old: the event is more than 7 days old when picked up (Meta's window; a Lead event's time is the lead's
//     creation time), or its Meta lead id is not valid. Never sendable: Meta cannot take it any more.
//   * exhausted: 5 send attempts failed (Meta / network / credentials down for a while). Sendable again if still in window.
// Operator command (default read-only; --execute applies):  node scripts/meta-crm-events-send.mjs --requeue-review [--execute]
// puts the still-sendable parked rows back in the queue (status failed, attempts 0) and the same run sends them.
import { randomUUID } from "node:crypto";
import { realpathSync as realpathOf } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { wonAmountForLead } from "../src/lib/won-amount.mjs";
import { latestQuotationAmount } from "../src/lib/quote-amount.mjs";
import { buildMetaCrmPayload, hashedContactKeys, normalizeLeadgenId, sendMetaCrmPayload } from "../src/lib/meta-crm-events.ts";
import { META_CRM_EVENT_MAX_AGE_SECONDS } from "../src/lib/meta-lead-ads.mjs";

// Meta accepts CRM events well inside its 28-day window; intake shares this limit.
const MAX_AGE_SECONDS = META_CRM_EVENT_MAX_AGE_SECONDS;
const MAX_ATTEMPTS = 5;

/** Looked up at send time so no contact data or amount is copied into the queue table. Failures degrade to a plain event. */
async function enrichment(db, row, env) {
  const extra = {};
  try {
    if ((row.event_name === "Won" || row.event_name === "Quoted") && row.lead_id) {
      // Quoted reports the quoted amount (main signal); Won the contract amount, else the amount the lead was won with.
      const amount = row.event_name === "Won" ? await wonAmountForLead(db, row.lead_id) : await latestQuotationAmount(db, row.lead_id);
      if (amount) { extra.value = amount.value; extra.currency = amount.currency; }
    }
    if (env.META_CRM_SEND_HASHED_CONTACT === "true" && row.lead_id) {
      const { data } = await db.from("leads").select("phone, email").eq("id", row.lead_id).maybeSingle();
      if (data) extra.match = hashedContactKeys(data);
    }
  } catch { /* plain event */ }
  return extra;
}

/** Parked rows split into "expired" (can never be sent: out of Meta's window or invalid id) and "recoverable". */
export async function requeueReviewRows(db, { execute = false, clock = () => Date.now() } = {}) {
  const out = { review_total: 0, review_expired: 0, review_recoverable: 0, requeued: 0, truncated: false };
  const read = await db.from("meta_crm_stage_events").select("id, meta_leadgen_id, event_time")
    .eq("status", "review_required").is("delivered_at", null).order("created_at", { ascending: true }).limit(1000);
  if (read.error) throw new Error("Meta CRM queue unavailable");
  const rows = read.data || [];
  out.review_total = rows.length; out.truncated = rows.length >= 1000;
  const nowSeconds = Math.floor(clock() / 1000);
  const ids = [];
  for (const r of rows) {
    const age = nowSeconds - Number(r.event_time);
    if (!Number.isFinite(age) || age > MAX_AGE_SECONDS || !normalizeLeadgenId(r.meta_leadgen_id)) out.review_expired++;
    else { out.review_recoverable++; ids.push(r.id); }
  }
  if (execute && ids.length) {
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const done = await db.from("meta_crm_stage_events").update({ status: "failed", attempts: 0, lease_id: null, lease_until: null })
        .in("id", part).eq("status", "review_required").select("id");
      if (done.error) throw new Error("Meta CRM requeue failed");
      out.requeued += (done.data || []).length;
    }
  }
  return out;
}

export async function sendMetaCrmEvents(db, { execute = false, limit = 50, clock = () => Date.now(),
  send = sendMetaCrmPayload, env = process.env, requeueReview = false } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid send limit");
  const requeue = requeueReview ? await requeueReviewRows(db, { execute, clock }) : null;
  const queue = await db.from("meta_crm_stage_events")
    .select("id, lead_id, meta_leadgen_id, event_name, event_time, status, attempts, lease_id, lease_until")
    .in("status", ["pending", "failed", "sending"]).lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true }).limit(limit);
  if (queue.error) throw new Error("Meta CRM queue unavailable");
  const summary = { mode: execute ? "execute" : "dry_run", examined: 0,
    delivered: 0, failed: 0, busy: 0, review_required: 0, errors: 0, exhausted: 0 };
  // Rows that ran out of attempts are never picked up again; without this count they would sit
  // in the queue forever while every run reports success (same rule as whatsapp-capi-send.mjs).
  const exhausted = await db.from("meta_crm_stage_events").select("id")
    .in("status", ["pending", "failed"]).gte("attempts", MAX_ATTEMPTS).limit(100);
  if (exhausted.error) throw new Error("Meta CRM queue unavailable");
  summary.exhausted = (exhausted.data || []).length;
  // Park them once (execute only): this run still counts them and fails, so one alert goes out; the next run is
  // clean again instead of failing every 10 minutes for the same rows.
  if (execute && summary.exhausted) {
    const parked = await db.from("meta_crm_stage_events").update({ status: "review_required" })
      .in("id", exhausted.data.map((r) => r.id)).in("status", ["pending", "failed"]).gte("attempts", MAX_ATTEMPTS);
    if (parked.error) summary.errors++;
  }
  for (const row of queue.data || []) {
    summary.examined++;
    if (!execute) continue;
    try {
      // Read the clock per row: a batch can outlive its start time, and a row
      // queued while the queue query ran must not look like it is from the future.
      const nowMs = clock();
      if (row.status === "sending" && Date.parse(row.lease_until || "") > nowMs) { summary.busy++; continue; }
      const ageSeconds = Math.floor(nowMs / 1000) - row.event_time;
      // Clock skew between app and sender: defer, never retire, a not-yet-due event.
      if (ageSeconds < 0) { summary.busy++; continue; }
      let payload;
      try {
        if (ageSeconds > MAX_AGE_SECONDS) throw new Error("age");
        // Quoted carries the quotation amount and Won the contract amount; hashed phone/email are opt-in (META_CRM_SEND_HASHED_CONTACT=true)
        // until Meta's acceptance of extra keys next to lead_id is confirmed with a test event.
        const extra = await enrichment(db, row, env);
        payload = buildMetaCrmPayload({ leadgenId: row.meta_leadgen_id, eventName: row.event_name, eventTime: row.event_time, eventId: row.id, ...extra });
      } catch {
        await db.from("meta_crm_stage_events").update({ status: "review_required" })
          .eq("id", row.id).eq("status", row.status).eq("attempts", row.attempts);
        summary.review_required++;
        continue;
      }
      const leaseId = randomUUID();
      const claimed = await db.from("meta_crm_stage_events").update({
        status: "sending", attempts: row.attempts + 1, lease_id: leaseId,
        // Lease from the claim moment: a slow batch must not claim with an already-expired lease.
        lease_until: new Date(clock() + 60_000).toISOString(),
      }).eq("id", row.id).eq("status", row.status).eq("attempts", row.attempts).select("id").maybeSingle();
      if (claimed.error) throw new Error("claim");
      if (!claimed.data) { summary.busy++; continue; }
      let outcome = "delivered";
      try { await send(payload); } catch { outcome = "failed"; }
      const done = await db.from("meta_crm_stage_events").update({
        status: outcome, ...(outcome === "delivered" ? { delivered_at: new Date().toISOString() } : {}),
      }).eq("id", row.id).eq("lease_id", leaseId).eq("status", "sending").select("id").maybeSingle();
      if (done.error || !done.data) throw new Error("receipt");
      summary[outcome]++;
    } catch { summary.errors++; }
  }
  // Only aggregate counts leave this tool; no lead ids, payloads or credentials.
  return requeue ? { ...summary, requeue } : summary;
}

// Main-module test by real path: systemd, cron and the Hermes scripts start this by the /opt/newme/current symlink, and Node
// reports import.meta.url as the resolved release directory, so comparing the unresolved argv[1] never matched there.
const isMainModule = () => { try { return Boolean(process.argv[1]) && realpathOf(process.argv[1]) === realpathOf(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--execute" && arg !== "--requeue-review")) {
    console.error("Usage: node scripts/meta-crm-events-send.mjs [--requeue-review] [--execute] (default: read-only)");
    process.exitCode = 2;
  } else {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("database configuration unavailable");
      if (args.includes("--execute") && (!process.env.META_PIXEL_ID || !process.env.META_CAPI_ACCESS_TOKEN)) {
        throw new Error("sender configuration unavailable");
      }
      const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const summary = await sendMetaCrmEvents(db, { execute: args.includes("--execute"), requeueReview: args.includes("--requeue-review") });
      console.log(JSON.stringify(summary));
      if (summary.errors || summary.failed || summary.review_required || summary.exhausted) process.exitCode = 1;
    } catch {
      console.error("Meta CRM send did not complete; inspect aggregate queue health before retrying.");
      process.exitCode = 1;
    }
  }
}
