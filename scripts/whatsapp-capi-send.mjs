#!/usr/bin/env node
// Prepared operator tool. Default is read-only; no scheduler is installed here.
// Sends queued click-to-WhatsApp events (LeadSubmitted, QualifiedLead, Purchase) to the Meta
// Conversions API for Business Messaging. Credentials come only from the server environment.
// Without META_WA_DATASET_ID the tool never sends: the queue just keeps filling.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildWhatsAppCapiPayload, sendWhatsAppCapiPayload, WA_CAPI_EVENT_MAX_AGE_SECONDS } from "../src/lib/whatsapp-capi.mjs";

const MAX_ATTEMPTS = 5;
const COLUMNS = "id, lead_id, waba_id, ctwa_clid, event_name, event_time, value, currency, status, attempts, lease_id, lease_until";

export async function sendWhatsAppCapiEvents(db, { execute = false, limit = 50, clock = () => Date.now(),
  send = sendWhatsAppCapiPayload } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid send limit");
  const queue = await db.from("whatsapp_capi_events").select(COLUMNS)
    .in("status", ["pending", "failed", "sending"]).lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true }).limit(limit);
  if (queue.error) throw new Error("WhatsApp CAPI queue unavailable");
  const summary = { mode: execute ? "execute" : "dry_run", examined: 0, delivered: 0, failed: 0, busy: 0,
    review_required: 0, errors: 0, exhausted: 0 };
  // A failed event that used every attempt is never picked up again: surface it so the operator sees it.
  const exhausted = await db.from("whatsapp_capi_events").select("id").in("status", ["failed", "sending"]).gte("attempts", MAX_ATTEMPTS).limit(100);
  if (exhausted.error) throw new Error("WhatsApp CAPI queue unavailable");
  summary.exhausted = (exhausted.data || []).length;
  for (const row of queue.data || []) {
    summary.examined++;
    if (!execute) continue;
    try {
      const nowMs = clock();
      if (row.status === "sending" && Date.parse(row.lease_until || "") > nowMs) { summary.busy++; continue; }
      const ageSeconds = Math.floor(nowMs / 1000) - row.event_time;
      if (ageSeconds < 0) { summary.busy++; continue; }
      let payload;
      try {
        if (ageSeconds > WA_CAPI_EVENT_MAX_AGE_SECONDS) throw new Error("age");
        payload = buildWhatsAppCapiPayload({ eventId: row.id, wabaId: row.waba_id, ctwaClid: row.ctwa_clid,
          eventName: row.event_name, eventTime: row.event_time, value: row.value === null ? null : Number(row.value), currency: row.currency });
      } catch {
        await db.from("whatsapp_capi_events").update({ status: "review_required" })
          .eq("id", row.id).eq("status", row.status).eq("attempts", row.attempts);
        summary.review_required++;
        continue;
      }
      const leaseId = randomUUID();
      const claimed = await db.from("whatsapp_capi_events").update({
        status: "sending", attempts: row.attempts + 1, lease_id: leaseId,
        lease_until: new Date(clock() + 60_000).toISOString(),
      }).eq("id", row.id).eq("status", row.status).eq("attempts", row.attempts).select("id").maybeSingle();
      if (claimed.error) throw new Error("claim");
      if (!claimed.data) { summary.busy++; continue; }
      let outcome = "delivered";
      try { await send(payload); } catch { outcome = "failed"; }
      const done = await db.from("whatsapp_capi_events").update({
        status: outcome, ...(outcome === "delivered" ? { delivered_at: new Date().toISOString() } : {}),
      }).eq("id", row.id).eq("lease_id", leaseId).eq("status", "sending").select("id").maybeSingle();
      if (done.error || !done.data) throw new Error("receipt");
      summary[outcome]++;
    } catch { summary.errors++; }
  }
  // Only aggregate counts leave this tool; no lead ids, click ids, payloads or credentials.
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--execute")) {
    console.error("Usage: node scripts/whatsapp-capi-send.mjs [--execute] (default: read-only)");
    process.exitCode = 2;
  } else {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("database configuration unavailable");
      const configured = Boolean(process.env.META_WA_DATASET_ID && process.env.META_CAPI_ACCESS_TOKEN);
      const execute = args.includes("--execute") && configured;
      const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const summary = await sendWhatsAppCapiEvents(db, { execute });
      console.log(JSON.stringify({ ...summary, ...(args.includes("--execute") && !configured ? { queue_only: "META_WA_DATASET_ID or token not set" } : {}) }));
      if (summary.errors || summary.failed || summary.review_required || summary.exhausted) process.exitCode = 1;
    } catch {
      console.error("WhatsApp CAPI send did not complete; inspect aggregate queue health before retrying.");
      process.exitCode = 1;
    }
  }
}
