// External authorization: Meta App Secret HMAC + page allowlist. RBAC: public (machine-to-machine).
// Realtime Meta Lead Ads (Instant Form) intake. Meta sends only the leadgen id;
// the lead is fetched from Graph with a server-side token and stored idempotently.
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { enqueueMetaCrmStageEvent } from "@/lib/meta-crm-events";
import {
  MAX_LEADGEN_WEBHOOK_BYTES, extractLeadgenNotifications, fetchMetaLead, mapMetaLeadToRow,
  storeMetaLead, verifyMetaSignature,
} from "@/lib/meta-lead-ads.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

function config() {
  const pageIds = (process.env.META_LEADGEN_PAGE_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return {
    enabled: process.env.META_LEADGEN_ENABLED === "true",
    verifyToken: process.env.META_LEADGEN_VERIFY_TOKEN,
    appSecret: process.env.META_APP_SECRET,
    accessToken: process.env.META_LEADS_ACCESS_TOKEN,
    version: process.env.META_GRAPH_API_VERSION || "v22.0",
    pageIds,
  };
}

export async function GET(request: Request) {
  const cfg = config();
  if (!cfg.enabled || !cfg.verifyToken) return reply({ error: "leadgen_disabled" }, 503);
  const query = new URL(request.url).searchParams;
  if (query.get("hub.mode") !== "subscribe" || query.get("hub.verify_token") !== cfg.verifyToken) {
    return reply({ error: "forbidden" }, 403);
  }
  const challenge = query.get("hub.challenge");
  if (!challenge || !/^\d{1,128}$/.test(challenge)) return reply({ error: "invalid_challenge" }, 400);
  return new Response(challenge, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const cfg = config();
  if (!cfg.enabled || !cfg.appSecret || !cfg.accessToken || cfg.pageIds.length === 0) {
    return reply({ error: "leadgen_disabled" }, 503);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return reply({ error: "unsupported_media_type" }, 415);
  }
  if (Number(request.headers.get("content-length")) > MAX_LEADGEN_WEBHOOK_BYTES) {
    return reply({ error: "payload_too_large" }, 413);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await request.arrayBuffer());
  } catch {
    return reply({ error: "invalid_body" }, 400);
  }
  if (bytes.byteLength > MAX_LEADGEN_WEBHOOK_BYTES) return reply({ error: "payload_too_large" }, 413);
  if (!verifyMetaSignature(bytes, request.headers.get("x-hub-signature-256"), cfg.appSecret)) {
    return reply({ error: "invalid_signature" }, 403);
  }
  let notifications;
  try {
    notifications = extractLeadgenNotifications(JSON.parse(bytes.toString("utf8")), cfg.pageIds);
  } catch {
    return reply({ error: "invalid_payload" }, 400);
  }

  const counts = { inserted: 0, merged: 0, duplicate: 0, failed: 0 };
  for (const note of notifications) {
    try {
      const lead = await fetchMetaLead(fetch, { version: cfg.version, token: cfg.accessToken, leadgenId: note.leadgen_id });
      const row = mapMetaLeadToRow(lead);
      const stored = await storeMetaLead(supabaseAdmin, row);
      counts[stored.outcome as keyof typeof counts] += 1;
      if (stored.id && stored.outcome !== "duplicate") {
        const eventTime = Math.floor(Date.parse(row.first_touch_at) / 1000);
        await enqueueMetaCrmStageEvent(supabaseAdmin, { id: stored.id, meta_leadgen_id: row.meta_leadgen_id }, "new", eventTime);
      }
    } catch {
      // No customer data, tokens or Graph bodies are logged. Meta retries on non-2xx;
      // storage is idempotent by leadgen id, and the pull script reconciles any gap.
      counts.failed += 1;
    }
  }
  console.info("[meta-leadgen] processed", counts);
  return reply({ received: true, ...counts }, counts.failed ? 503 : 200);
}
