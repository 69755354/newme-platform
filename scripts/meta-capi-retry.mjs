#!/usr/bin/env node
// Prepared operator tool. Default is read-only; no scheduler is installed here.
import { fileURLToPath } from "node:url";
import { realpathSync as realpathOf } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { attemptCapiDelivery, kindOfOutboxRow, LEAD_DELIVERY, OUTBOX_KINDS, WA_QUOTE_DELIVERY } from "../src/lib/meta-capi-delivery.ts";
import { sendWhatsAppCapiPayload } from "../src/lib/whatsapp-capi.mjs";
import { sendMetaCapiPayload } from "../src/lib/meta-capi.ts";

export async function retryCapiDeliveries(db, { execute = false, limit = 20, now = Date.now(),
  send = sendMetaCapiPayload, sendWhatsApp = sendWhatsAppCapiPayload } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid retry limit");
  const summary = { mode: execute ? "execute" : "dry_run", examined: 0,
    delivered: 0, failed: 0, busy: 0, review_required: 0, errors: 0 };
  // One outbox type; the kind (website Lead, website quote/purchase, WhatsApp quote) comes from the stored payload.
  const widest = Math.max(...Object.values(OUTBOX_KINDS).map((k) => k.maxAgeMs));
  const result = await db.from("business_events").select("id, event_data")
    .eq("event_type", LEAD_DELIVERY.eventType)
    .in("event_data->>status", ["pending", "failed", "sending"])
    .in("event_data->>attempts", ["0", "1", "2", "3", "4"])
    .gte("created_at", new Date(now - widest).toISOString())
    // Over-fetch: rows past their own kind's window (e.g. a Lead older than 24h) are skipped below and must not
    // use up the batch, or they would starve newer rows. At most `limit` rows are examined.
    .order("created_at", { ascending: true }).limit(Math.min(limit * 10, 1000));
  if (result.error) throw new Error("CAPI retry queue unavailable");
  for (const row of result.data || []) {
    if (summary.examined >= limit) break;
    const kind = kindOfOutboxRow(row);
    const queuedMs = Date.parse(row.event_data?.queued_at);
    // Unknown kinds are left alone; rows past their kind's window keep the old behaviour (not retried here).
    if (!kind || (Number.isFinite(queuedMs) && now - queuedMs >= kind.maxAgeMs)) continue;
    summary.examined++;
    if (!execute) continue;
    try {
      const sender = kind === WA_QUOTE_DELIVERY ? sendWhatsApp : send;
      const outcome = await attemptCapiDelivery(db, row, sender, Date.now(), kind);
      if (outcome === "review_required") {
        // Persist terminal validation failures so subsequent batches advance.
        // Compare the observed state; never replace a concurrent sender's receipt.
        let mark = db.from("business_events").update({ event_data: {
          ...row.event_data, status: "review_required", review_required_at: new Date().toISOString(),
        } }).eq("id", row.id).eq("event_type", kind.eventType)
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

// Main-module test by real path: systemd, cron and the Hermes scripts start this by the /opt/newme/current symlink, and Node
// reports import.meta.url as the resolved release directory, so comparing the unresolved argv[1] never matched there.
const isMainModule = () => { try { return Boolean(process.argv[1]) && realpathOf(process.argv[1]) === realpathOf(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMainModule()) {
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
