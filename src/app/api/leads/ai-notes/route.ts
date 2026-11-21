// POST /api/leads/ai-notes — machine token only (Authorization: Bearer AI_NOTES_TOKEN, >= 32 chars, constant-time compare).
// PREPARED, NOT ENABLED: answers 503 unless AI_NOTES_ENABLED=true. Body: { items: [{ lead_id, summary, suggested_quality, reason, watermark? }] }, max 50.
// Writes one `activities` row per lead (type note, ai_generated, metadata.source = ai_note). It never writes the leads table:
// quality, stage, owner and Meta feedback are untouched. Idempotent per lead + watermark (newest customer message time covered).
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import { clientIdentifier, consumeRateLimit } from "@/lib/rate-limit";
import { AI_NOTE_SOURCE, MAX_ITEMS_PER_CALL, bearerToken, noteContent, noteImportKey, resolveAiNotesConfig, tokenMatches, validateItem } from "@/lib/wa-ai-notes.mjs";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 200_000;
const CALLS_PER_MINUTE = 20;

type Json = Record<string, unknown>;
const reply = (body: Json, status = 200, headers: Record<string, string> = {}) => {
  const r = NextResponse.json(body, { status, headers });
  r.headers.set("Cache-Control", "private, no-store");
  return r;
};

async function newestMessageAt(leadId: string): Promise<string | null> {
  const { data: convs, error } = await supabaseAdmin.from("whatsapp_conversations").select("id").eq("lead_id", leadId);
  if (error || !convs?.length) return null;
  const { data, error: e2 } = await supabaseAdmin.from("whatsapp_message_events").select("occurred_at").in("conversation_id", convs.map((c: { id: string }) => c.id)).order("occurred_at", { ascending: false }).limit(1);
  if (e2 || !data?.length) return null;
  return new Date(data[0].occurred_at).toISOString();
}

export async function POST(request: NextRequest) {
  if (!resolveAiNotesConfig(process.env).enabled) return reply({ error: "Disabled", reason: "AI_NOTES_ENABLED is not true" }, 503);
  // Every attempt, right or wrong, spends the per-source budget before the token is compared.
  const limit = consumeRateLimit(clientIdentifier(request), { limit: CALLS_PER_MINUTE, windowMs: 60_000, namespace: "ai-notes" });
  if (!limit.allowed) return reply({ error: "Too many requests" }, 429, { "Retry-After": String(limit.retryAfterSeconds) });
  if (!tokenMatches(bearerToken(request.headers), process.env.AI_NOTES_TOKEN)) return reply({ error: "Unauthorized" }, 401);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return reply({ error: "Body too large" }, 413);

  let body: Json;
  try { body = (await request.json()) as Json; } catch { return reply({ error: "Invalid JSON" }, 400); }
  const raw = body?.items;
  if (!Array.isArray(raw)) return reply({ error: "items must be an array" }, 400);
  if (raw.length > MAX_ITEMS_PER_CALL) return reply({ error: `Too many items (max ${MAX_ITEMS_PER_CALL})`, max: MAX_ITEMS_PER_CALL }, 413);

  const results: Json[] = [];
  const counts = { created: 0, duplicate: 0, not_found: 0, invalid: 0, failed: 0 };
  try {
    for (const entry of raw) {
      const v = validateItem(entry);
      if (!v.item) { counts.invalid += 1; results.push({ lead_id: typeof (entry as Json)?.lead_id === "string" ? (entry as Json).lead_id : null, status: "invalid", reason: v.error }); continue; }
      const item = v.item;
      try {
        const { data: lead, error: leadErr } = await supabaseAdmin.from("leads").select("id").eq("id", item.lead_id).maybeSingle();
        if (leadErr) throw new Error("lead_read_failed");
        if (!lead) { counts.not_found += 1; results.push({ lead_id: item.lead_id, status: "not_found" }); continue; }
        const watermark = item.watermark ?? (await newestMessageAt(item.lead_id)) ?? new Date().toISOString();
        const { data: prior, error: priorErr } = await supabaseAdmin.from("activities").select("metadata").eq("lead_id", item.lead_id).eq("metadata->>source", AI_NOTE_SOURCE).order("created_at", { ascending: false }).limit(20);
        if (priorErr) throw new Error("note_read_failed");
        // Covered already: some earlier note carries a watermark at or after this one.
        if ((prior ?? []).some((p: { metadata: Json | null }) => typeof p.metadata?.watermark === "string" && Date.parse(p.metadata.watermark) >= Date.parse(watermark))) {
          counts.duplicate += 1; results.push({ lead_id: item.lead_id, status: "duplicate" }); continue;
        }
        const { error: insErr } = await supabaseAdmin.from("activities").insert({
          lead_id: item.lead_id, type: "note", content: noteContent(item), ai_generated: true,
          metadata: { source: AI_NOTE_SOURCE, import_key: noteImportKey(item.lead_id, watermark), watermark, summary: item.summary, suggested_quality: item.suggested_quality, reason: item.reason, advisory: true },
        });
        if (insErr) throw new Error("note_insert_failed");
        counts.created += 1; results.push({ lead_id: item.lead_id, status: "created", watermark });
      } catch (err) {
        counts.failed += 1; results.push({ lead_id: item.lead_id, status: "failed", reason: err instanceof Error ? err.message : "unknown" });
      }
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : "unknown" }, "ai-notes failed");
    return reply({ error: "Failed" }, 500);
  }
  return reply({ ok: counts.failed === 0, counts, results }, counts.failed ? 207 : 200);
}
