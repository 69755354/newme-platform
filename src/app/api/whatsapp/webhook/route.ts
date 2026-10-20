// External authorization: Meta App Secret HMAC, exact opt-in channel allowlist.
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { MAX_WEBHOOK_BYTES, extractWhatsAppEvents, verifyWhatsAppSignature, type PilotChannel } from "@/lib/whatsapp-pilot.mjs";

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
  const secret = process.env.WHATSAPP_APP_SECRET;
  const salt = process.env.WHATSAPP_PILOT_CONTACT_SALT;
  if (process.env.WHATSAPP_PILOT_ENABLED !== "true" || !secret || !salt) return reply({ error: "pilot_disabled" }, 503);
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
  if (!verifyWhatsAppSignature(bytes, request.headers.get("x-hub-signature-256"), secret)) return reply({ error: "invalid_signature" }, 403);
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString("utf8")); }
  catch { return reply({ error: "invalid_json" }, 400); }
  try {
    const { data: channels, error } = await supabaseAdmin.from("whatsapp_pilot_channels").select("*").eq("enabled", true);
    if (error) return reply({ error: "channel_lookup_failed" }, 503);
    let events;
    try { events = extractWhatsAppEvents(payload, (channels ?? []) as PilotChannel[], salt); }
    catch { return reply({ error: "invalid_payload" }, 400); }
    if (events.length) {
      // A single statement is atomic. Retries never update or duplicate old facts.
      const { error: writeError } = await supabaseAdmin.from("whatsapp_pilot_events").upsert(events, {
        onConflict: "channel_id,message_id", ignoreDuplicates: true,
      });
      if (writeError) return reply({ error: "event_write_failed" }, 503);
    }
    return reply({ received: true });
  } catch {
    // Do not log raw bodies, customer identifiers, secrets or database errors.
    return reply({ error: "storage_unavailable" }, 503);
  }
}
