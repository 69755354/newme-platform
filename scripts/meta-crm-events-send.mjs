#!/usr/bin/env node
// Prepared operator tool. Default is read-only; no scheduler is installed here.
// Sends queued Meta CRM stage events. Credentials come only from the server environment.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildMetaCrmPayload, sendMetaCrmPayload } from "../src/lib/meta-crm-events.ts";

const MAX_AGE_SECONDS = 7 * 86_400; // Meta accepts CRM events well inside its 28-day window.

export async function sendMetaCrmEvents(db, { execute = false, limit = 50, nowMs = Date.now(),
  send = sendMetaCrmPayload } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid send limit");
  const queue = await db.from("meta_crm_stage_events")
    .select("id, meta_leadgen_id, event_name, event_time, status, attempts, lease_id, lease_until")
    .in("status", ["pending", "failed", "sending"]).lt("attempts", 5)
    .order("created_at", { ascending: true }).limit(limit);
  if (queue.error) throw new Error("Meta CRM queue unavailable");
  const summary = { mode: execute ? "execute" : "dry_run", examined: 0,
    delivered: 0, failed: 0, busy: 0, review_required: 0, errors: 0 };
  for (const row of queue.data || []) {
    summary.examined++;
    if (!execute) continue;
    try {
      if (row.status === "sending" && Date.parse(row.lease_until || "") > nowMs) { summary.busy++; continue; }
      let payload;
      const ageSeconds = Math.floor(nowMs / 1000) - row.event_time;
      try {
        if (ageSeconds < 0 || ageSeconds > MAX_AGE_SECONDS) throw new Error("age");
        payload = buildMetaCrmPayload({ leadgenId: row.meta_leadgen_id, eventName: row.event_name, eventTime: row.event_time });
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
        lease_until: new Date(Date.now() + 60_000).toISOString(),
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
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--execute")) {
    console.error("Usage: node scripts/meta-crm-events-send.mjs [--execute] (default: read-only)");
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
      const summary = await sendMetaCrmEvents(db, { execute: args.includes("--execute") });
      console.log(JSON.stringify(summary));
      if (summary.errors || summary.failed || summary.review_required) process.exitCode = 1;
    } catch {
      console.error("Meta CRM send did not complete; inspect aggregate queue health before retrying.");
      process.exitCode = 1;
    }
  }
}
