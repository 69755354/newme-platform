#!/usr/bin/env node
// Prepared operator tool. Default is read-only; no scheduler is installed here.
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { attemptCapiDelivery } from "../src/lib/meta-capi-delivery.ts";
import { sendMetaCapiPayload } from "../src/lib/meta-capi.ts";

export async function retryCapiDeliveries(db, { execute = false, limit = 20, now = Date.now(),
  send = sendMetaCapiPayload } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid retry limit");
  const result = await db.from("business_events").select("id, event_data")
    .eq("event_type", "meta_capi_lead_delivery")
    .in("event_data->>status", ["pending", "failed", "sending"])
    .in("event_data->>attempts", ["0", "1", "2", "3", "4"])
    .gte("created_at", new Date(now - 86_400_000).toISOString())
    .order("created_at", { ascending: true }).limit(limit);
  if (result.error) throw new Error("CAPI retry queue unavailable");
  const summary = { mode: execute ? "execute" : "dry_run", examined: 0,
    delivered: 0, failed: 0, busy: 0, review_required: 0, errors: 0 };
  for (const row of result.data || []) {
    summary.examined++;
    if (!execute) continue;
    try {
      const outcome = await attemptCapiDelivery(db, row, send, Date.now());
      if (outcome === "review_required") {
        // Persist terminal validation failures so subsequent batches advance.
        // Compare the observed state; never replace a concurrent sender's receipt.
        let mark = db.from("business_events").update({ event_data: {
          ...row.event_data, status: "review_required", review_required_at: new Date().toISOString(),
        } }).eq("id", row.id).eq("event_type", "meta_capi_lead_delivery")
          .eq("event_data->>status", row.event_data.status)
          .eq("event_data->>attempts", String(row.event_data.attempts));
        if (row.event_data.lease_id) mark = mark.eq("event_data->>lease_id", row.event_data.lease_id);
        const marked = await mark.select("id").maybeSingle();
        if (marked.error) throw new Error("CAPI review receipt unavailable");
        if (!marked.data) { summary.busy++; continue; }
      }
      summary[outcome]++;
    }
    catch { summary.errors++; }
  }
  // Only aggregate counts leave this tool; no payloads, contacts or credentials.
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--execute")) {
    console.error("Usage: node scripts/meta-capi-retry.mjs [--execute] (default: read-only)");
    process.exitCode = 2;
  } else {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("CAPI retry database configuration unavailable");
      if (args.includes("--execute") && (!process.env.META_PIXEL_ID || !process.env.META_CAPI_ACCESS_TOKEN)) {
        throw new Error("CAPI sender configuration unavailable");
      }
      const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const summary = await retryCapiDeliveries(db, { execute: args.includes("--execute") });
      console.log(JSON.stringify(summary));
      if (summary.errors || summary.failed || summary.review_required) process.exitCode = 1;
    } catch {
      console.error("CAPI retry did not complete; inspect aggregate queue health before retrying.");
      process.exitCode = 1;
    }
  }
}
