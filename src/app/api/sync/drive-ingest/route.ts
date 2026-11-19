// RBAC: machine token only (Authorization: Bearer DRIVE_SYNC_INGEST_TOKEN, constant-time compare). PREPARED, NOT ENABLED:
// answers 503 "Disabled" unless DRIVE_SYNC_INGEST_ENABLED=true is set in the runtime environment (S29).
//
// POST /api/sync/drive-ingest   body: { run_id, dry_run, changes: [ ...normalized sheet rows... ] }
// The reader script (scripts/drive-to-os-sync.mjs) reads the Drive sheets (read-only), normalises rows and sends them here;
// this route is the only writer. It matches rows to leads, applies the field-ownership rules of src/lib/drive-sync.mjs
// (Drive owns follow-up text, next action, lead quality + reason; OS owns ids, source, ad ids, assignment, stage, milestones,
// contract; empty values never overwrite; won/lost stages untouched; archived leads stay archived), writes a note per applied
// change into `activities` (metadata.source = drive_sync, no migration) and appends one JSONL line per decision to the sync log.
// Idempotent: a row whose Drive-owned content did not change since the last sync is a no-op.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import { clientIdentifier, consumeRateLimit } from "@/lib/rate-limit";
import { fetchAllRows } from "@/lib/fetch-all-rows.mjs";
import { SYNC_SOURCE, bearerToken, maskId, planBatch, resolveConfig, tokenMatches, validateChange, writeCost } from "@/lib/drive-sync.mjs";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 2_000_000;
const CALLS_PER_MINUTE = 30;
const LEAD_COLUMNS = "id, import_fingerprint, meta_leadgen_id, phone, email, archived, stage, final_status, quality, next_action, poor_reason, updated_at, drive_sync:raw_import_data->drive_sync";
const SIDE_EFFECT_TABLES = ["notifications", "tasks", "meta_crm_stage_events", "whatsapp_capi_events"] as const;
const INSERT_COLUMNS = ["customer_name", "phone", "email", "source", "source_channel", "source_platform", "meta_leadgen_id", "campaign_id", "adset_id", "ad_id", "campaign_name", "ad_name", "location", "notes", "created_at"];

type Json = Record<string, unknown>;
const noStore = <T extends Response>(r: T): T => { r.headers.set("Cache-Control", "private, no-store"); return r; };
const reply = (body: Json, status = 200) => noStore(NextResponse.json(body, { status }));

function logFile() {
  const dir = process.env.DRIVE_SYNC_DATA_DIR || "/var/lib/newme/drive-sync";
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  return path.join(dir, "sync-log.jsonl");
}

async function sideEffectCounts() {
  const out: Record<string, number> = {};
  for (const t of SIDE_EFFECT_TABLES) {
    const { count, error } = await supabaseAdmin.from(t).select("id", { count: "exact", head: true });
    if (error) throw new Error(`count_failed_${t}`);
    out[t] = count ?? 0;
  }
  return out;
}

export async function POST(request: NextRequest) {
  const cfg = resolveConfig(process.env);
  if (!cfg.enabled) return reply({ error: "Disabled", reason: "DRIVE_SYNC_INGEST_ENABLED is not true" }, 503);
  // Every attempt, right or wrong, spends the per-source budget before the token is compared.
  const limit = consumeRateLimit(clientIdentifier(request), { limit: CALLS_PER_MINUTE, windowMs: 60_000, namespace: "drive-sync-ingest" });
  if (!limit.allowed) return noStore(NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }));
  if (!tokenMatches(bearerToken(request.headers), process.env.DRIVE_SYNC_INGEST_TOKEN)) return reply({ error: "Unauthorized" }, 401);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return reply({ error: "Body too large" }, 413);

  let body: Json;
  try { body = (await request.json()) as Json; } catch { return reply({ error: "Invalid JSON" }, 400); }
  const changes = body.changes;
  if (!Array.isArray(changes)) return reply({ error: "changes must be an array" }, 400);
  if (changes.length > cfg.maxChangesPerCall) return reply({ error: `Too many changes in one call (max ${cfg.maxChangesPerCall})`, max: cfg.maxChangesPerCall }, 413);
  for (const c of changes) { const bad = validateChange(c); if (bad) return reply({ error: `Invalid change: ${bad}` }, 400); }
  const dryRun = body.dry_run !== false; // anything but an explicit false is a dry run
  const runId = typeof body.run_id === "string" ? body.run_id.slice(0, 64) : "unknown";

  try {
    const { data: leadRows, error: leadErr, truncated } = await fetchAllRows((from: number, to: number, withCount: boolean) =>
      supabaseAdmin.from("leads").select(LEAD_COLUMNS, withCount ? { count: "exact" } : undefined).order("id").range(from, to));
    if (leadErr || truncated) throw new Error("lead_query_failed");
    const plan = planBatch(changes as Json[], (leadRows ?? []) as Json[], cfg);
    const summary = plan.decisions.map(({ change, d }) => ({ key: maskId(change.key), sheet: change.sheet, row: change.row, action: d.action, reason: d.reason ?? null, fields: d.fields ?? [], conflicts: d.conflicts ?? [] }));
    if (dryRun) return reply({ ok: true, dry_run: true, counts: plan.counts, decisions: summary });

    // Fail closed: if the sync log cannot be written nothing is applied.
    const file = logFile();
    const log = (line: Json) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), run_id: runId, ...line })}\n`, { mode: 0o640 });
    log({ event: "batch_start", changes: changes.length, writes_planned: plan.counts.writes });
    if (plan.counts.writes > cfg.maxWritesPerRun) return reply({ error: "Planned writes exceed the cap", writes: plan.counts.writes, cap: cfg.maxWritesPerRun }, 413);

    const before = await sideEffectCounts();
    const applied = { inserted: 0, updated: 0, notes: 0, failed: 0 };
    const nowIso = new Date().toISOString();
    for (const { change, d } of plan.decisions) {
      const k = maskId(change.key);
      try {
        if (d.action === "insert") {
          const f = (change.insert_fields ?? {}) as Json;
          const row: Json = { stage: "new", quality: (change.owned as Json | undefined)?.quality ?? "pending", import_fingerprint: (change.identity as Json | undefined)?.fingerprint ?? null };
          for (const col of INSERT_COLUMNS) if (f[col] !== undefined && f[col] !== null && f[col] !== "") row[col] = f[col];
          row.raw_import_data = { drive_sync: { row_hash: d.row_hash, synced_at: nowIso, key: change.key, sheet: change.sheet, row: change.row, inserted_by: SYNC_SOURCE } };
          if (!row.source) row.source = "unknown_import";
          const { data, error } = await supabaseAdmin.from("leads").insert(row).select("id").single();
          if (error || !data) throw new Error("insert_failed");
          await supabaseAdmin.from("activities").insert({ lead_id: data.id, type: "note", content: "Drive sync: lead created from sheet row", metadata: { source: SYNC_SOURCE, import_key: `${change.key}/drive-sync/${String(d.row_hash).slice(0, 16)}`, run_id: runId } });
          applied.inserted += 1;
          log({ event: "insert", key: k, sheet: change.sheet, row: change.row, lead_id: data.id });
        } else if (d.action === "update") {
          const patch: Json = { ...d.set };
          if (d.unarchive) Object.assign(patch, { archived: false, archived_at: null, archive_batch_id: null, archive_reason: null });
          const rawPatch = { drive_sync: { ...d.raw_patch.drive_sync, synced_at: nowIso } };
          const { data: cur } = await supabaseAdmin.from("leads").select("raw_import_data").eq("id", d.lead_id).single();
          patch.raw_import_data = { ...((cur?.raw_import_data as Json | null) ?? {}), ...rawPatch };
          const { error } = await supabaseAdmin.from("leads").update(patch).eq("id", d.lead_id);
          if (error) throw new Error("update_failed");
          for (const n of d.notes ?? []) {
            const { data: ex } = await supabaseAdmin.from("activities").select("id, content").eq("lead_id", d.lead_id).eq("metadata->>import_key", n.import_key).limit(1);
            if (ex?.length) { if (ex[0].content !== n.content) { await supabaseAdmin.from("activities").update({ content: n.content }).eq("id", ex[0].id); applied.notes += 1; } }
            else { await supabaseAdmin.from("activities").insert({ lead_id: d.lead_id, type: n.type, content: n.content, metadata: { source: SYNC_SOURCE, import_key: n.import_key, run_id: runId } }); applied.notes += 1; }
          }
          const changed = [...(d.fields ?? [])].join(", ") || "sync state";
          await supabaseAdmin.from("activities").insert({ lead_id: d.lead_id, type: "note", content: `Drive sync: ${changed}${d.conflicts?.length ? ` (conflicts: ${d.conflicts.map((c: Json) => `${c.field}->${c.winner}`).join(", ")})` : ""}`, metadata: { source: SYNC_SOURCE, import_key: `${change.key}/drive-sync/${String(d.row_hash).slice(0, 16)}`, run_id: runId, fields: d.fields, conflicts: d.conflicts } });
          applied.updated += 1;
          log({ event: "update", key: k, sheet: change.sheet, row: change.row, lead_id: d.lead_id, fields: d.fields, conflicts: d.conflicts, row_hash: d.row_hash, cost: writeCost(d) });
        } else if (d.action !== "noop") {
          log({ event: d.action, key: k, sheet: change.sheet, row: change.row, reason: d.reason ?? null });
        }
      } catch (err) {
        applied.failed += 1;
        log({ event: "error", key: k, sheet: change.sheet, row: change.row, error: err instanceof Error ? err.message : "unknown" });
      }
    }
    const after = await sideEffectCounts();
    const sideEffectsChanged = SIDE_EFFECT_TABLES.filter((t) => before[t] !== after[t]);
    log({ event: "batch_end", applied, side_effects_changed: sideEffectsChanged });
    return reply({ ok: applied.failed === 0 && sideEffectsChanged.length === 0, dry_run: false, counts: plan.counts, applied, side_effects: { before, after, changed: sideEffectsChanged }, decisions: summary }, applied.failed ? 207 : 200);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : "unknown" }, "drive-sync ingest failed");
    return reply({ error: "Ingest failed" }, 500);
  }
}
