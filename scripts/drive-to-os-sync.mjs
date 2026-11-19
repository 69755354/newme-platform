#!/usr/bin/env node
// Drive sheets -> OS reader (S29). READ-ONLY toward Drive: only GET requests, read-only scopes, no writes to any Drive file.
// Reads each source tab once (values API), normalizes rows like the one-time backfill, asks the OS ingest endpoint for a plan
// (insert / update / skip / hold) and, only with --apply, lets that endpoint write. This script never writes to the database.
//
//   node scripts/drive-to-os-sync.mjs --run-now [--dry-run | --apply] [--offline] [--os-snapshot FILE] [--max-writes N] [--data-dir DIR]
//
// Default mode is --dry-run (DRIVE_SYNC_MODE=apply or --apply switches it). Exit codes: 0 ok, 2 anomaly, 3 write cap exceeded, 64 usage.
// Reports hold counts, masked ids and sheet/row numbers only: never names, phone numbers or e-mails.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSheetsReader } from "./lib/drive-sheets-readonly.mjs";
import { SOURCES, buildChanges, rangeOf, toTab } from "./lib/drive-sync-sources.mjs";
import { DEFAULT_MAX_CHANGES_PER_CALL, DEFAULT_MAX_WRITES_PER_RUN, maskId, planBatch, resolveConfig } from "../src/lib/drive-sync.mjs";

const EXIT = { ok: 0, anomaly: 2, cap: 3, usage: 64 };
const DROP_ALERT_RATIO = 0.5; // a tab that lost more than half of its rows since the last run is an anomaly

export function parseArgs(argv, env = process.env) {
  const a = { runNow: false, mode: env.DRIVE_SYNC_MODE === "apply" ? "apply" : "dry-run", offline: false, snapshot: null, maxWrites: Number(env.DRIVE_SYNC_MAX_WRITES) || DEFAULT_MAX_WRITES_PER_RUN, dataDir: env.DRIVE_SYNC_DATA_DIR || null, endpoint: env.DRIVE_SYNC_ENDPOINT || "http://127.0.0.1:3001/api/sync/drive-ingest", only: null, batch: DEFAULT_MAX_CHANGES_PER_CALL };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === "--run-now") a.runNow = true;
    else if (x === "--dry-run") a.mode = "dry-run";
    else if (x === "--apply") a.mode = "apply";
    else if (x === "--offline") a.offline = true;
    else if (x === "--os-snapshot") a.snapshot = argv[++i];
    else if (x === "--max-writes") a.maxWrites = Number(argv[++i]);
    else if (x === "--data-dir") a.dataDir = argv[++i];
    else if (x === "--endpoint") a.endpoint = argv[++i];
    else if (x === "--only") a.only = String(argv[++i]).split(",");
    else if (x === "--batch") a.batch = Number(argv[++i]);
    else a.unknown = x;
  }
  return a;
}

function pickDataDir(want) {
  for (const d of [want, "/var/lib/newme/drive-sync", path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "newme-drive-sync")].filter(Boolean)) {
    try { mkdirSync(path.join(d, "reports"), { recursive: true, mode: 0o750 }); return d; } catch { /* next */ }
  }
  throw new Error("no writable data directory (set DRIVE_SYNC_DATA_DIR)");
}

async function callEndpoint(deps, args, token, body) {
  const r = await deps.fetch(args.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json };
}

/** The whole run. deps = { reader:{getValues,getModifiedTime}, fetch, now } so tests inject fake sheets and a fake endpoint. */
export async function runSync({ argv = [], env = process.env, deps = {} } = {}) {
  const args = parseArgs(argv, env);
  const out = []; const say = (s) => out.push(s);
  const now = deps.now ?? (() => new Date());
  if (!args.runNow || args.unknown) return { code: EXIT.usage, report: "usage: drive-to-os-sync.mjs --run-now [--dry-run|--apply] [--offline] [--os-snapshot FILE] [--max-writes N]", out };
  const reader = deps.reader ?? createSheetsReader();
  const doFetch = deps.fetch ?? fetch;
  const dataDir = pickDataDir(args.dataDir);
  const runId = randomUUID();
  const stamp = now().toISOString();
  const anomalies = [];
  const lock = path.join(dataDir, "run.lock");
  if (existsSync(lock) && Date.now() - Number(readFileSync(lock, "utf8") || 0) < 3_600_000) return { code: EXIT.anomaly, report: "another run is in progress (run.lock)", out };
  writeFileSync(lock, String(Date.now()), { mode: 0o640 });
  try {
    // 1) read: one values GET per tab (read-only)
    const tabs = {}; const modified = {}; const perSheet = {}; const modCache = {};
    for (const src of SOURCES.filter((s) => !args.only || args.only.includes(s.key))) {
      try {
        const values = await reader.getValues(src.spreadsheet_id, rangeOf(src));
        if (!(src.spreadsheet_id in modCache)) modCache[src.spreadsheet_id] = (await reader.getModifiedTime?.(src.spreadsheet_id)) ?? null;
        modified[src.key] = modCache[src.spreadsheet_id];
        const tab = toTab(src, values);
        if (tab.missing.length) { anomalies.push(`${src.key}: required columns missing (${tab.missing.length}); tab skipped`); perSheet[src.key] = { read: 0, skipped_tab: true }; continue; }
        tabs[src.key] = tab; perSheet[src.key] = { read: tab.rows.length };
      } catch (err) { anomalies.push(`${src.key}: read failed (${err.message})`); perSheet[src.key] = { read: 0, failed: true }; }
    }
    const changes = buildChanges(tabs, modified);
    const prevFile = path.join(dataDir, "last-run.json");
    const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, "utf8")) : null;
    for (const [k, v] of Object.entries(perSheet)) {
      const p = prev?.per_sheet?.[k]?.read;
      if (!v.failed && !v.skipped_tab && p >= 10 && v.read < p * DROP_ALERT_RATIO) anomalies.push(`${k}: row count fell from ${p} to ${v.read}`);
    }

    // 2) plan: against the OS (endpoint) or a local snapshot / nothing (offline)
    const token = env.DRIVE_SYNC_INGEST_TOKEN;
    let decisions = null; let counts = null; let osState = "offline";
    if (args.snapshot) {
      const plan = planBatch(changes, JSON.parse(readFileSync(args.snapshot, "utf8")), resolveConfig({ ...env, DRIVE_SYNC_ENABLED: "true" }));
      decisions = plan.decisions.map(({ change, d }) => ({ key: maskId(change.key), sheet: change.sheet, row: change.row, action: d.action, reason: d.reason ?? null, fields: d.fields ?? [], conflicts: d.conflicts ?? [] }));
      counts = plan.counts; osState = "snapshot";
    } else if (!args.offline) {
      if (!token) { anomalies.push("DRIVE_SYNC_INGEST_TOKEN not set: cannot ask the OS for a plan"); }
      else {
        const all = []; let cnt = { read: 0, matched: 0, inserted: 0, would_insert: 0, updated: 0, noop: 0, skipped: 0, held: 0, conflicts: 0, writes: 0 };
        let failed = false;
        for (let i = 0; i < changes.length; i += args.batch) {
          const { status, json } = await callEndpoint({ fetch: doFetch }, args, token, { run_id: runId, dry_run: true, changes: changes.slice(i, i + args.batch) });
          if (status !== 200 || !json?.ok) { failed = true; anomalies.push(`endpoint plan call failed (status ${status}${json?.error ? `: ${json.error}` : ""})`); break; }
          all.push(...json.decisions); for (const k of Object.keys(cnt)) cnt[k] += json.counts[k] ?? 0;
        }
        if (!failed) { decisions = all; counts = cnt; osState = "endpoint"; }
      }
    }
    if (!counts) counts = { read: changes.length, matched: 0, inserted: 0, would_insert: 0, updated: 0, noop: 0, skipped: changes.filter((c) => c.skip_reason).length, held: changes.filter((c) => c.hold_reason).length, conflicts: 0, writes: 0 };

    // 3) apply (only with --apply, only through the endpoint, never past the cap)
    let applied = null;
    if (args.mode === "apply") {
      if (osState !== "endpoint") anomalies.push("apply requested but no OS plan available: nothing written");
      else if (counts.writes > args.maxWrites) { say(`write cap: plan needs ${counts.writes} writes, cap is ${args.maxWrites}; nothing written`); return finish(EXIT.cap); }
      else {
        applied = { inserted: 0, updated: 0, notes: 0, failed: 0 };
        for (let i = 0; i < changes.length; i += args.batch) {
          const { status, json } = await callEndpoint({ fetch: doFetch }, args, token, { run_id: runId, dry_run: false, changes: changes.slice(i, i + args.batch) });
          if (!json || (status !== 200 && status !== 207)) { anomalies.push(`endpoint apply call failed (status ${status})`); break; }
          for (const k of Object.keys(applied)) applied[k] += json.applied?.[k] ?? 0;
          if (json.side_effects?.changed?.length) anomalies.push(`side-effect tables changed: ${json.side_effects.changed.join(",")}`);
        }
        if (applied.failed) anomalies.push(`${applied.failed} change(s) failed to apply`);
      }
    }
    return finish(anomalies.length ? EXIT.anomaly : EXIT.ok);

    function finish(code) {
      const lines = [];
      lines.push(`NEWME Drive -> OS sync report`, `run ${runId}  at ${stamp}  mode ${args.mode}  os-state ${osState}`);
      lines.push("", "Counts", `  read      ${counts.read}`, `  matched   ${counts.matched}`, `  inserted  ${counts.inserted}${args.mode === "apply" ? "" : " (planned)"}`, `  updated   ${counts.updated}${args.mode === "apply" ? "" : " (planned)"}`, `  unchanged ${counts.noop}`, `  skipped   ${counts.skipped}`, `  held      ${counts.held}${counts.would_insert ? ` (of which ${counts.would_insert} would be inserts; inserts are disabled)` : ""}`, `  conflicts ${counts.conflicts}`, `  writes    ${counts.writes} (cap ${args.maxWrites})`);
      if (applied) lines.push(`  applied   inserted ${applied.inserted}, updated ${applied.updated}, notes ${applied.notes}, failed ${applied.failed}`);
      lines.push("", "Rows read per tab"); for (const [k, v] of Object.entries(perSheet)) lines.push(`  ${k}: ${v.read}${v.failed ? " (read failed)" : v.skipped_tab ? " (columns missing)" : ""}`);
      const quiet = (d) => d.reason === "marketing_no_drive_owned_content";
      const list = (decisions ?? []).filter((d) => !quiet(d) && (d.action === "hold" || d.action === "skip" || d.conflicts?.length));
      const fallback = decisions ? [] : changes.filter((c) => (c.hold_reason || c.skip_reason) && c.skip_reason !== "marketing_no_drive_owned_content").map((c) => ({ key: maskId(c.key), sheet: c.sheet, row: c.row, action: c.hold_reason ? "hold" : "skip", reason: c.hold_reason || c.skip_reason, conflicts: [] }));
      const unmatched = [...list, ...fallback];
      lines.push("", `Unmatched / held / skipped / conflict rows (sheet, row, masked id, reason): ${unmatched.length}`);
      for (const d of unmatched.slice(0, 300)) lines.push(`  ${d.sheet} row ${d.row} ${d.key} ${d.action}${d.reason ? ` ${d.reason}` : ""}${d.conflicts?.length ? ` conflict:${d.conflicts.map((c) => `${c.field}->${c.winner}`).join(",")}` : ""}`);
      if (unmatched.length > 300) lines.push(`  ... ${unmatched.length - 300} more`);
      lines.push("", anomalies.length ? `ANOMALIES (${anomalies.length})` : "No anomalies"); for (const a of anomalies) lines.push(`  - ${a}`);
      const report = lines.join("\n");
      const file = path.join(dataDir, "reports", `drive-sync-${stamp.replace(/[:.]/g, "-")}-${args.mode}.txt`);
      writeFileSync(file, `${report}\n`, { mode: 0o640 });
      if (!anomalies.some((a) => /read failed|columns missing/.test(a))) writeFileSync(prevFile, JSON.stringify({ at: stamp, per_sheet: perSheet }), { mode: 0o640 });
      appendFileSync(path.join(dataDir, "runs.jsonl"), `${JSON.stringify({ at: stamp, run_id: runId, mode: args.mode, code, counts, applied, anomalies: anomalies.length })}\n`, { mode: 0o640 });
      return { code, report, reportFile: file, counts, decisions, anomalies, applied, changes, out };
    }
  } finally { try { unlinkSync(lock); } catch { /* gone */ } }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runSync({ argv: process.argv.slice(2) }).then((r) => { console.log(r.report); if (r.reportFile) console.log(`\nreport file: ${r.reportFile}`); process.exit(r.code); })
    .catch((err) => { console.error(`drive-to-os-sync failed: ${err.message}`); process.exit(EXIT.anomaly); });
}
