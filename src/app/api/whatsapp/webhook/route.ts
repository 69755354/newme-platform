// External authorization: Meta App Secret HMAC, exact opt-in channel allowlist.
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { MAX_WEBHOOK_BYTES, extractWhatsAppEvents, isWhatsAppEventFresh, verifyWhatsAppSignature, type PilotChannel } from "@/lib/whatsapp-pilot.mjs";
import { extractWhatsAppAdEvents } from "@/lib/whatsapp-ctwa.mjs";
import { adLeadsEnabled, organicLeadsEnabled, recordWhatsAppAdEvents } from "@/lib/whatsapp-ctwa-ingest.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function GET(request: Request) {
  const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!token || process.env.WHATSAPP_PILOT_ENABLED !== "true") return reply({ error: "pilot_disabled" }, 503);
  const query = new URL(request.url).searchParams;
  if (query.get("hub.mode") !== "subscribe" || query.get("hub.verify_token") !== token) return reply({ error: "forbidden" }, 403);
  const challenge = query.get("hub.challenge");
  if (!challenge || !/^\d{1,128}$/.test(challenge)) return reply({ error: "invalid_challenge" }, 400);
  return new Response(challenge, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  // The Meta app that owns the WABA subscription signs with META_APP_SECRET; WHATSAPP_APP_SECRET is
  // accepted too. Either one matching is enough.
  const secrets = [process.env.WHATSAPP_APP_SECRET, process.env.META_APP_SECRET].filter((v): v is string => Boolean(v));
  const salt = process.env.WHATSAPP_PILOT_CONTACT_SALT;
  if (process.env.WHATSAPP_PILOT_ENABLED !== "true" || secrets.length === 0 || !salt) return reply({ error: "pilot_disabled" }, 503);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return reply({ error: "unsupported_media_type" }, 415);
  if (Number(request.headers.get("content-length")) > MAX_WEBHOOK_BYTES) return reply({ error: "payload_too_large" }, 413);
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: "invalid_body" }, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        return reply({ error: "payload_too_large" }, 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return reply({ error: "invalid_body" }, 400);
  }
  const bytes = Buffer.concat(chunks);
  if (!verifyWhatsAppSignature(bytes, request.headers.get("x-hub-signature-256"), secrets)) return reply({ error: "invalid_signature" }, 403);
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString("utf8")); }
  catch { return reply({ error: "invalid_json" }, 400); }
  try {
    const { data: channels, error } = await supabaseAdmin.from("whatsapp_pilot_channels").select("*").eq("enabled", true);
    if (error) return reply({ error: "channel_lookup_failed" }, 503);
    let events;
    try { events = extractWhatsAppEvents(payload, (channels ?? []) as PilotChannel[], salt); }
    catch { return reply({ error: "invalid_payload" }, 400); }
    // Parsing a bounded batch may cross the age boundary. Recheck just before
    // dispatch. Database admission independently enforces expiry, maintenance
    // health and deletion cutoffs under its transaction lock.
    const writeTime = Date.now();
    events = events.filter(event => isWhatsAppEventFresh(Date.parse(event.occurred_at), writeTime));
    let pilotFailed = false;
    if (events.length) {
      // A single statement is atomic. Existing rows are never updated; surviving
      // keys deduplicate retries. The database suppresses deleted-customer retries.
      const { error: writeError } = await supabaseAdmin.from("whatsapp_pilot_events").upsert(events, {
        onConflict: "channel_id,message_id", ignoreDuplicates: true,
      });
      pilotFailed = Boolean(writeError);
    }
    // The database privacy admission (stale maintenance, expiry, deletion cutoff) guards the pilot
    // table only. When that write fails, collection is paused: answer 503 without touching the ad
    // path, so no lead or feedback is created. Meta retries the whole delivery, nothing is lost.
    if (pilotFailed) return reply({ error: "event_write_failed" }, 503);
    // Click-to-WhatsApp attribution: match or create the lead and keep the ad click id. It runs
    // for the same verified body, is idempotent per message id and customer phone, and a failure
    // makes Meta retry the whole delivery, so no ad lead is lost. Ids, times and the text of text messages are
    // stored (S21); media links and ad body text never are.
    let adFailed = false;
    if (adLeadsEnabled()) {
      try {
        const adEvents = extractWhatsAppAdEvents(payload, (channels ?? []) as PilotChannel[], writeTime)
          .filter(event => isWhatsAppEventFresh(Date.parse(event.occurred_at), writeTime));
        if (adEvents.length) {
          const summary = await recordWhatsAppAdEvents(supabaseAdmin, adEvents, { createOrganic: organicLeadsEnabled() });
          adFailed = summary.failed > 0;
        }
      } catch { adFailed = true; }
    }
    if (adFailed) return reply({ error: "ad_event_write_failed" }, 503);
    return reply({ received: true });
  } catch {
    // Do not log raw bodies, customer identifiers, secrets or database errors.
    return reply({ error: "storage_unavailable" }, 503);
  }
}
