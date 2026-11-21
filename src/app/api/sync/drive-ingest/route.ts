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
import { enqueueMetaCrmEventForLead } from "@/lib/meta-crm-events";
import { enqueueWebsiteQuoteForProgress, enqueueWhatsAppProgressWithDelivery } from "@/lib/website-capi-valued";
import { SYNC_SOURCE, bearerToken, claimTag, maskId, mergeDriveSync, planBatch, resolveConfig, tokenMatches, validateChange, validateClaims, writeCost } from "@/lib/drive-sync.mjs";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 2_000_000;
const CALLS_PER_MINUTE = 30;
const LEAD_COLUMNS = "id, import_fingerprint, meta_leadgen_id, phone, email, archived, stage, final_status, quality, quotation_value, next_action, next_followup_date, poor_reason, updated_at, drive_sync:raw_import_data->drive_sync";
const SIDE_EFFECT_TABLES = ["notifications", "tasks", "meta_crm_stage_events", "whatsapp_capi_events"] as const;
// A fresh sheet quote is the one allowed side effect: at most one form-lead event and two WhatsApp queue rows per quote.
const QUOTE_EVENT_ROWS: Record<string, number> = { meta_crm_stage_events: 1, whatsapp_capi_events: 2 };
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

type Note = { import_key: string; type: string; content: string };
async function insertNote(leadId: string, n: Note, runId: string, extra: Json = {}) {
  const { error } = await supabaseAdmin.from("activities").insert({ lead_id: leadId, type: n.type, content: n.content, metadata: { source: SYNC_SOURCE, import_key: n.import_key, run_id: runId, ...extra } });
  return !error;
}
/** Insert the note, or refresh its text when the same import_key already exists. false = a write failed. */
async function upsertNote(leadId: string, n: Note, runId: string) {
  const { data: ex, error } = await supabaseAdmin.from("activities").select("id, content").eq("lead_id", leadId).eq("metadata->>import_key", n.import_key).limit(1);
  if (error) return false;
  if (!ex?.length) return insertNote(leadId, n, runId);
  if (ex[0].content === n.content) return true;
  const { error: upErr } = await supabaseAdmin.from("activities").update({ content: n.content }).eq("id", ex[0].id);
  return !upErr;
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
  const badClaims = validateClaims(body.claims);
  if (badClaims) return reply({ error: `Invalid claims: ${badClaims}` }, 400);
  const dryRun = body.dry_run !== false; // anything but an explicit false is a dry run
  const runId = typeof body.run_id === "string" ? body.run_id.slice(0, 64) : "unknown";

  try {
    const { data: leadRows, error: leadErr, truncated } = await fetchAllRows((from: number, to: number, withCount: boolean) =>
      supabaseAdmin.from("leads").select(LEAD_COLUMNS, withCount ? { count: "exact" } : undefined).order("id").range(from, to));
    if (leadErr || truncated) throw new Error("lead_query_failed");
    // claims: leads claimed / new people reserved by earlier batches of this run (returned below, sent back by the reader).
    const plan = planBatch(changes as Json[], (leadRows ?? []) as Json[], cfg, (body.claims ?? null) as Record<string, string> | null);
    const summary = plan.decisions.map(({ change, d }) => ({ key: maskId(change.key), sheet: change.sheet, row: change.row, action: d.action, reason: d.reason ?? null, fields: d.fields ?? [], conflicts: d.conflicts ?? [] }));
    if (dryRun) return reply({ ok: true, dry_run: true, counts: plan.counts, decisions: summary, claims: plan.claims });

    // Fail closed: if the sync log cannot be written nothing is applied.
    const file = logFile();
    const log = (line: Json) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), run_id: runId, ...line })}\n`, { mode: 0o640 });
    log({ event: "batch_start", changes: changes.length, writes_planned: plan.counts.writes });
    if (plan.counts.writes > cfg.maxWritesPerRun) return reply({ error: "Planned writes exceed the cap", writes: plan.counts.writes, cap: cfg.maxWritesPerRun }, 413);

    const before = await sideEffectCounts();
    const applied = { inserted: 0, updated: 0, notes: 0, failed: 0 };
    let quotesFired = 0;
    let stagesAdvanced = 0;
    for (const { change, d } of plan.decisions) {
      const k = maskId(change.key);
      try {
        if (d.action === "insert") {
          const f = (change.insert_fields ?? {}) as Json;
          const row: Json = { stage: "new", quality: (change.owned as Json | undefined)?.quality ?? "pending", import_fingerprint: (change.identity as Json | undefined)?.fingerprint ?? null };
          for (const col of INSERT_COLUMNS) if (f[col] !== undefined && f[col] !== null && f[col] !== "") row[col] = f[col];
          Object.assign(row, d.set);
          if (!row.source) row.source = "unknown_import";
          // The row hash is committed only after every part is written, so a failed part is retried by the next run.
          row.raw_import_data = { drive_sync: { ...d.raw_patch.drive_sync, row_hash: null, synced_at: null, inserted_by: SYNC_SOURCE } };
          const { data, error } = await supabaseAdmin.from("leads").insert(row).select("id").single();
          if (error || !data) throw new Error("insert_failed");
          for (const n of d.notes ?? []) { if (await upsertNote(data.id, n, runId)) applied.notes += 1; else throw new Error("note_failed"); }
          if (!(await insertNote(data.id, { import_key: `${change.key}/drive-sync/${String(d.row_hash).slice(0, 16)}`, type: "note", content: "Drive sync: lead created from sheet row" }, runId))) throw new Error("sync_note_failed");
          // synced_at is stamped at the commit itself, so the updated_at bump of this write stays inside the tolerance.
          const { error: hashErr } = await supabaseAdmin.from("leads").update({ raw_import_data: { drive_sync: { ...d.raw_patch.drive_sync, synced_at: new Date().toISOString(), inserted_by: SYNC_SOURCE } } }).eq("id", data.id);
          if (hashErr) throw new Error("hash_commit_failed");
          plan.claims[String(data.id)] = String(d.claim_tag ?? claimTag(change.key)); // a later batch matching this new lead is held
          applied.inserted += 1;
          log({ event: "insert", key: k, sheet: change.sheet, row: change.row, lead_id: data.id });
        } else if (d.action === "update") {
          const patch: Json = { ...d.set };
          if (d.unarchive) Object.assign(patch, { archived: false, archived_at: null, archive_batch_id: null, archive_reason: null });
          if (Object.keys(patch).length) {
            const { error } = await supabaseAdmin.from("leads").update(patch).eq("id", d.lead_id);
            if (error) throw new Error("update_failed");
          }
          for (const n of d.notes ?? []) { if (await upsertNote(d.lead_id, n, runId)) applied.notes += 1; else throw new Error("note_failed"); }
          const changed = [...(d.fields ?? [])].join(", ") || "sync state";
          const conflictText = d.conflicts?.length ? ` (conflicts: ${d.conflicts.map((c: Json) => `${c.field}->${c.winner}`).join(", ")})` : "";
          if (!(await insertNote(d.lead_id, { import_key: `${change.key}/drive-sync/${String(d.row_hash).slice(0, 16)}`, type: "note", content: `Drive sync: ${changed}${conflictText}` }, runId, { fields: d.fields, conflicts: d.conflicts }))) throw new Error("sync_note_failed");
          // Sheet says "quotation reported": move the OS stage forward through the service-role routine (S33). Forward only, one
          // audited step at a time, never past quotation_submitted; it answers a reason instead of failing when a rule says "not yet"
          // (first contact incomplete, no next follow-up). Never fatal: a missing routine (not provisioned yet) or a refusal is logged
          // and the sync carries on exactly as before.
          if (d.stage_advance) {
            const { data: adv, error: advErr } = await supabaseAdmin.rpc("sync_advance_lead_stage_from_sheet", { p_lead_id: d.lead_id, p_target_stage: "quotation_submitted", p_run_id: runId });
            if (advErr) log({ event: "stage_advance_unavailable", key: k, lead_id: d.lead_id, code: advErr.code ?? null });
            else { const r = (adv ?? {}) as Json; if (r.advanced === true) stagesAdvanced += 1; log({ event: "stage_advance", key: k, lead_id: d.lead_id, advanced: r.advanced === true, from: r.from ?? null, to: r.to ?? null, reason: r.reason ?? null }); }
          }
          // Fresh quote in the sheet: send the same Meta feedback as a quotation made in OS (all helpers are idempotent per lead).
          if (d.quote) {
            await enqueueMetaCrmEventForLead(supabaseAdmin, d.lead_id, "quotation_submitted");
            await enqueueWhatsAppProgressWithDelivery(supabaseAdmin, d.lead_id, "quotation_submitted");
            await enqueueWebsiteQuoteForProgress(supabaseAdmin, d.lead_id, "quotation_submitted");
            quotesFired += 1;
            log({ event: "quote_feedback", key: k, lead_id: d.lead_id, stage_pending: d.quote.stage_pending === true });
          }
          // Last step: commit the row hash. Anything above that failed leaves the old hash, so the row is retried.
          const { data: cur, error: curErr } = await supabaseAdmin.from("leads").select("raw_import_data").eq("id", d.lead_id).single();
          if (curErr) throw new Error("read_failed");
          // Merge, not replace: a blank sheet cell keeps the stored next date / first contact / contact rule.
          const curRaw = ((cur?.raw_import_data as Json | null) ?? {});
          const { error: hashErr } = await supabaseAdmin.from("leads").update({ raw_import_data: { ...curRaw, drive_sync: { ...mergeDriveSync(curRaw.drive_sync, d.raw_patch.drive_sync), synced_at: new Date().toISOString() } } }).eq("id", d.lead_id);
          if (hashErr) throw new Error("hash_commit_failed");
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
    const sideEffectsChanged = SIDE_EFFECT_TABLES.filter((t) => { const grown = after[t] - before[t]; return grown < 0 || grown > (QUOTE_EVENT_ROWS[t] ?? 0) * quotesFired; });
    log({ event: "batch_end", applied, stages_advanced: stagesAdvanced, side_effects_changed: sideEffectsChanged });
    return reply({ ok: applied.failed === 0 && sideEffectsChanged.length === 0, dry_run: false, counts: plan.counts, applied, stages_advanced: stagesAdvanced, side_effects: { before, after, changed: sideEffectsChanged }, decisions: summary, claims: plan.claims }, applied.failed ? 207 : 200);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : "unknown" }, "drive-sync ingest failed");
    return reply({ error: "Ingest failed" }, 500);
  }
}
