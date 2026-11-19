#!/usr/bin/env node
// OS -> Google Sheets + NAS incremental push (S28). Run by newme-os-drive-sync.timer every 5 minutes.
//   node scripts/os-drive-nas-sync.mjs [--dry-run] [--reconcile] [--full] [--max-writes N] [--leads-file F]
// Default off: without OS_DRIVE_SYNC_ENABLED=true a real run does nothing. --dry-run only reads and prints
// the planned writes. See docs/s28-drive-nas-sync.md. Never prints keys, phone numbers or click ids.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMetaIdRows, leadRef } from "../src/lib/meta-ids-export.mjs";
import { createSheetsClient, loadServiceAccount } from "../src/lib/google-sheets-client.mjs";
import {
  DEFAULTS, SyncError, a1Tab, assertWithinCap, buildWritePolicy, columnLetter, diffReadBack, dubaiDay, formatReport, guardSheets,
  maxIso, normalizeState, parseCsv, planCtwaColumnX, planMetaIdsUpsert, reconcileMetaIds, shouldAlert, sinceFromCursor,
} from "../src/lib/os-drive-sync.mjs";

const LEAD_COLUMNS = "id, meta_leadgen_id, ctwa_clid, campaign_id, campaign_name, adset_id, ad_id, ad_name, created_at, stage, final_status, archived, updated_at, phone";
const PAGE = 1000;
const WIDTH = columnLetter(15 - 1);

// ---------- OS reader (Supabase, service role, read-only) ----------
export function createOsReader(db) {
  const must = (r, code) => { if (r.error) throw new SyncError(code, code); return r.data ?? []; };
  const readAll = async (build, code) => {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = must(await build().range(offset, offset + PAGE - 1), code);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  };
  const idChunks = (ids) => { const c = []; for (let i = 0; i < ids.length; i += 200) c.push(ids.slice(i, i + 200)); return c; };
  return {
    async leadsChangedSince(since) {
      return readAll(() => {
        let q = db.from("leads").select(LEAD_COLUMNS).or("meta_leadgen_id.not.is.null,ctwa_clid.not.is.null");
        if (since) q = q.gt("updated_at", since);
        return q.order("updated_at", { ascending: true }).order("id", { ascending: true });
      }, "lead_query_failed");
    },
    async leadIdsWithEventsSince(since) {
      const ids = new Set();
      for (const table of ["meta_crm_stage_events", "whatsapp_capi_events"]) {
        for (const col of ["created_at", "delivered_at"]) {
          const rows = await readAll(() => db.from(table).select("id, lead_id").gt(col, since).order("id", { ascending: true }), "event_query_failed");
          for (const r of rows) ids.add(r.lead_id);
        }
      }
      return [...ids];
    },
    async leadsByIds(ids) {
      const out = [];
      for (const chunk of idChunks(ids)) out.push(...must(await db.from("leads").select(LEAD_COLUMNS).in("id", chunk), "lead_query_failed"));
      return out;
    },
    async eventsForLeads(leads) {
      const form = []; const wa = [];
      const read = (table, ids) => readAll(() => db.from(table).select("id, lead_id, event_name, status, created_at, delivered_at").in("lead_id", ids)
        .order("created_at", { ascending: true }).order("id", { ascending: true }), "event_query_failed");
      for (const chunk of idChunks(leads.map((l) => l.id))) {
        const formIds = leads.filter((l) => chunk.includes(l.id) && l.meta_leadgen_id).map((l) => l.id);
        const waIds = leads.filter((l) => chunk.includes(l.id) && l.ctwa_clid).map((l) => l.id);
        if (formIds.length) form.push(...await read("meta_crm_stage_events", formIds));
        if (waIds.length) wa.push(...await read("whatsapp_capi_events", waIds));
      }
      return { formEvents: form, whatsappEvents: wa };
    },
  };
}

// ---------- NAS (existing upload helper) ----------
export function createNas({ script = process.env.NAS_UPLOAD_SCRIPT || "/usr/local/libexec/newme/newme-nas-upload.sh", remoteDir }) {
  return {
    upload: (file) => new Promise((resolve, reject) => {
      const child = spawn(script, ["--overwrite", file, remoteDir], { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", () => reject(new SyncError("nas_upload_failed", "NAS upload helper could not start")));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new SyncError("nas_upload_failed", `NAS upload helper exited ${code}`))));
    }),
  };
}

// ---------- file io (state, spool, reports) ----------
export function createIo(dataDir, metaIdsDir) {
  const stateFile = join(dataDir, "state.json");
  const ensure = (d) => mkdirSync(d, { recursive: true, mode: 0o700 });
  return {
    dataDir,
    readState() { try { return normalizeState(JSON.parse(readFileSync(stateFile, "utf8"))); } catch { return normalizeState(null); } },
    writeState(state) { // atomic: temp file, fsync, rename
      ensure(dataDir);
      const tmp = `${stateFile}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, `${JSON.stringify(state, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, stateFile);
    },
    appendChanges(day, lines) {
      const dir = join(dataDir, "changes"); ensure(dir);
      const file = join(dir, `${day}.jsonl`);
      appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
      chmodSync(file, 0o600);
      return { file, size: statSync(file).size };
    },
    changesFile(day) { const file = join(dataDir, "changes", `${day}.jsonl`); return existsSync(file) ? { file, size: statSync(file).size } : null; },
    writeReport(day, text) {
      const dir = join(dataDir, "reports"); ensure(dir);
      const file = join(dir, `reconcile-${day}.txt`);
      writeFileSync(file, text, { mode: 0o600 });
      return file;
    },
    latestNightlyCsv() {
      try {
        const names = readdirSync(metaIdsDir).filter((n) => /^meta-ids-\d{8}\.csv$/.test(n)).sort();
        return names.length ? { name: names[names.length - 1], text: readFileSync(join(metaIdsDir, names[names.length - 1]), "utf8") } : null;
      } catch { return null; }
    },
  };
}

// ---------- shared pieces ----------
const toLeadView = (l) => ({ lead_ref: l.__ref, phone: l.phone, ctwa_clid: l.ctwa_clid, created_at: l.created_at });

async function loadSheetGrids(sheets, cfg, titles, { needSales }) {
  const meta = await sheets.getValues(cfg.metaSheetId, `${a1Tab(titles.meta)}!A:${WIDTH}`);
  let sales = null;
  if (needSales) {
    const [phoneRows, clidRows] = await sheets.batchGetValues(cfg.salesSheetId, [
      `${a1Tab(cfg.salesTab)}!${cfg.phoneColumn}:${cfg.phoneColumn}`, `${a1Tab(cfg.salesTab)}!${cfg.clidColumn}:${cfg.clidColumn}`]);
    sales = { phoneCol: phoneRows.map((r) => r[0] ?? ""), clidCol: clidRows.map((r) => r[0] ?? "") };
  }
  return { meta, sales };
}

async function verifyAndRetry(sheets, id, writes, rewrite) {
  const read = async () => sheets.batchGetValues(id, writes.map((w) => w.range));
  let bad = diffReadBack(writes, (await read()).map((values) => ({ values })));
  if (bad.length) {
    await rewrite(writes.filter((w) => bad.includes(w.range)));
    bad = diffReadBack(writes, (await read()).map((values) => ({ values })));
  }
  if (bad.length) throw new SyncError("readback_mismatch", `read-back mismatch on ${bad.length} range(s) after one retry`);
}

// ---------- the sync run ----------
export async function runSync({ osReader, sheets, nas, io, cfg = DEFAULTS, args = {}, now = () => Date.now(), log = console.log, leadsOverride = null }) {
  const startedAt = new Date(now()).toISOString();
  const day = dubaiDay(now());
  const state = io.readState();
  const full = Boolean(args.full) || !state.leads_cursor;
  const since = full ? null : sinceFromCursor(state.leads_cursor, cfg.overlapSeconds);
  const summary = { mode: args.dryRun ? "dry_run" : "execute", full };

  // 1. which leads to look at
  let leads;
  if (leadsOverride) leads = leadsOverride; // dry-run fixture only
  else {
    const byId = new Map();
    for (const l of await osReader.leadsChangedSince(since)) byId.set(l.id, l);
    if (since) {
      const evIds = (await osReader.leadIdsWithEventsSince(since)).filter((id) => !byId.has(id));
      const pendingIds = Object.keys(state.pending_ctwa).filter((id) => !byId.has(id) && !evIds.includes(id));
      for (const l of await osReader.leadsByIds([...evIds, ...pendingIds])) byId.set(l.id, l);
    }
    leads = [...byId.values()];
  }
  summary.leads_examined = leads.length;
  const events = leadsOverride ? { formEvents: [], whatsappEvents: [] } : await osReader.eventsForLeads(leads);
  const osRows = buildMetaIdRows(leads, events.formEvents, events.whatsappEvents);
  const refOf = new Map(leads.map((l) => [l.id, leadRef(l.id)]));
  const ctwaLeads = leads.filter((l) => l.ctwa_clid).map((l) => toLeadView({ ...l, __ref: refOf.get(l.id) }));
  const idByRef = new Map(leads.map((l) => [refOf.get(l.id), l.id]));

  // 2. read sheets and plan (read-only so far)
  const titles = { meta: await sheets.getFirstSheetTitle(cfg.metaSheetId) };
  const grids = await loadSheetGrids(sheets, cfg, titles, { needSales: ctwaLeads.length > 0 });
  const planA = planMetaIdsUpsert(grids.meta, osRows);
  const planB = grids.sales ? planCtwaColumnX(grids.sales.phoneCol, grids.sales.clidCol, ctwaLeads, cfg, state.x_written)
    : { writes: [], unchanged: 0, unmatched: [], ambiguous: [], manual: [], conflicts: 0 };
  Object.assign(summary, {
    meta_updates: planA.updates.length, meta_appends: planA.appends.length, meta_unchanged: planA.unchanged, meta_duplicate_keys: planA.duplicateSheetKeys,
    x_writes: planB.writes.length, x_manual_skipped: planB.manual.length, x_unchanged: planB.unchanged, x_unmatched: planB.unmatched.length, x_ambiguous: planB.ambiguous.length,
  });
  const planned = planA.updates.length + planA.appends.length + planB.writes.length;
  summary.planned_writes = planned;

  if (args.dryRun) {
    for (const u of planA.updates.slice(0, 5)) log(`dry-run: update Meta IDs row ${u.row}`);
    for (const w of planB.writes.slice(0, 5)) log(`dry-run: write ${cfg.clidColumn}${w.row} on ${cfg.salesTab} (${w.lead_ref})`);
    return { summary, exitCode: planned > args.maxWrites ? 3 : 0 };
  }
  assertWithinCap(planned, args.maxWrites); // throws before anything is written

  // 3. write + read back
  const changes = []; const ts = startedAt;
  const guarded = guardSheets(sheets, buildWritePolicy({ ...cfg, metaTab: titles.meta }));
  if (planA.updates.length) {
    const data = planA.updates.map((u) => ({ range: `${a1Tab(titles.meta)}!A${u.row}:${WIDTH}${u.row}`, values: [u.values] }));
    await guarded.batchUpdateValues(cfg.metaSheetId, data);
    await verifyAndRetry(guarded, cfg.metaSheetId, data, (bad) => guarded.batchUpdateValues(cfg.metaSheetId, bad));
    for (const u of planA.updates) changes.push({ ts, sheet: "meta_ids", action: "update", row: u.row, lead_ref: u.values[0], meta_id_type: u.values[2], meta_id: u.values[3], values: u.values, previous: u.previous });
  }
  if (planA.appends.length) {
    const res = await guarded.appendValues(cfg.metaSheetId, `${a1Tab(titles.meta)}!A1`, planA.appends);
    const updated = res?.updates?.updatedRange;
    if (!updated) throw new SyncError("append_no_range", "append did not report where it wrote");
    const back = await guarded.batchGetValues(cfg.metaSheetId, [updated]);
    if (diffReadBack([{ range: updated, values: planA.appends }], [{ values: back[0] }]).length) {
      throw new SyncError("readback_mismatch", "read-back mismatch after append");
    }
    for (const v of planA.appends) changes.push({ ts, sheet: "meta_ids", action: "append", lead_ref: v[0], meta_id_type: v[2], meta_id: v[3], values: v });
  }
  if (planB.writes.length) {
    const data = planB.writes.map((w) => ({ range: `${a1Tab(cfg.salesTab)}!${cfg.clidColumn}${w.row}`, values: [[w.value]] }));
    await guarded.batchUpdateValues(cfg.salesSheetId, data);
    await verifyAndRetry(guarded, cfg.salesSheetId, data, (bad) => guarded.batchUpdateValues(cfg.salesSheetId, bad));
    for (const w of planB.writes) changes.push({ ts, sheet: "home_owners_x", action: "write", row: w.row, lead_ref: w.lead_ref, value: w.value });
  }

  for (const w of planB.writes) state.x_written[w.lead_ref] = w.value;

  // 4. NAS spool + upload (a failed upload is retried next run, it never blocks the cursor)
  let nasError = null;
  if (changes.length) io.appendChanges(day, changes);
  const spool = io.changesFile(day);
  if (spool && state.nas_uploaded[day] !== spool.size) {
    try { await nas.upload(spool.file); state.nas_uploaded[day] = spool.size; } catch (e) { nasError = e; }
  }

  // 5. cursor + pending list, saved last
  const seenAt = maxIso(...leads.map((l) => l.updated_at), state.leads_cursor);
  state.leads_cursor = seenAt ?? state.leads_cursor ?? startedAt;
  const pendingNow = { ...state.pending_ctwa };
  for (const l of ctwaLeads) delete pendingNow[idByRef.get(l.lead_ref)];
  const stillOpen = new Set([...planB.unmatched.filter((u) => u.reason === "no_row").map((u) => u.lead_ref), ...planB.ambiguous.map((a) => a.lead_ref)]);
  for (const ref of stillOpen) pendingNow[idByRef.get(ref)] = pendingNow[idByRef.get(ref)] ?? startedAt;
  for (const [id, first] of Object.entries(pendingNow)) if (now() - Date.parse(first) > cfg.pendingDays * 86_400_000) delete pendingNow[id];
  state.pending_ctwa = pendingNow;
  state.last_run_at = startedAt; state.last_ok_at = startedAt; state.consecutive_failures = 0;
  io.writeState(state);
  summary.nas_error = nasError ? nasError.code : null;
  summary.requests = sheets.requestCount ?? null;
  return { summary, exitCode: nasError ? 1 : 0 };
}

// ---------- nightly reconcile ----------
export async function runReconcile({ osReader, sheets, io, cfg = DEFAULTS, now = () => Date.now(), leadsOverride = null }) {
  const day = dubaiDay(now());
  const leads = leadsOverride ?? await osReader.leadsChangedSince(null);
  const events = leadsOverride ? { formEvents: [], whatsappEvents: [] } : await osReader.eventsForLeads(leads);
  const osRows = buildMetaIdRows(leads, events.formEvents, events.whatsappEvents);
  const title = await sheets.getFirstSheetTitle(cfg.metaSheetId);
  const ctwa = leads.filter((l) => l.ctwa_clid).map((l) => toLeadView({ ...l, __ref: leadRef(l.id) }));
  const grids = await loadSheetGrids(sheets, cfg, { meta: title }, { needSales: ctwa.length > 0 });
  const nightly = io.latestNightlyCsv();
  const meta = reconcileMetaIds(osRows, grids.meta, nightly ? parseCsv(nightly.text) : null);
  if (nightly) meta.nas_file = nightly.name;
  let x = null;
  if (grids.sales) {
    const p = planCtwaColumnX(grids.sales.phoneCol, grids.sales.clidCol, ctwa, cfg, io.readState().x_written);
    x = { os_leads_with_click_id: ctwa.length, already_in_sheet: p.unchanged, would_write: p.writes.length, unmatched: p.unmatched.length, ambiguous: p.ambiguous.length, manual_value_skipped: p.manual.length };
  }
  const state = io.readState();
  const ageMin = state.last_ok_at ? Math.round((now() - Date.parse(state.last_ok_at)) / 60_000) : null;
  const health = { last_ok_minutes_ago: ageMin ?? "never", consecutive_failures: state.consecutive_failures, pending_unmatched_click_ids: Object.keys(state.pending_ctwa).length };
  const stale = ageMin === null || ageMin > 60 || state.consecutive_failures >= 3;
  const drift = meta.drift || (x?.would_write ?? 0) > 0 || stale;
  const text = formatReport({ day, mode: drift ? "DRIFT" : "ok", meta, ctwa: x, health, notes: drift ? ["Drift found: the 5-minute worker normally closes it; if it persists, check the worker log."] : [] });
  const file = io.writeReport(day, text);
  return { summary: { drift, report: file, ...meta }, exitCode: drift ? 1 : 0 };
}

// ---------- CLI ----------
export function parseArgs(argv) {
  const out = { dryRun: false, reconcile: false, full: false, maxWrites: DEFAULTS.maxWrites, leadsFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--reconcile") out.reconcile = true;
    else if (a === "--full") out.full = true;
    else if (a === "--max-writes") out.maxWrites = Number(argv[++i]);
    else if (a === "--leads-file") out.leadsFile = argv[++i];
    else throw new SyncError("usage", `unknown argument ${a}`);
  }
  if (!Number.isInteger(out.maxWrites) || out.maxWrites < 0) throw new SyncError("usage", "--max-writes needs a non-negative integer");
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\nUsage: os-drive-nas-sync.mjs [--dry-run] [--reconcile] [--full] [--max-writes N] [--leads-file F]`); process.exit(2); }
  const env = process.env;
  if (!args.dryRun && env.OS_DRIVE_SYNC_ENABLED !== "true") { console.log("OS_DRIVE_SYNC_ENABLED is not true: nothing to do"); return; }
  const dataDir = env.OS_DRIVE_SYNC_DATA_DIR || "/var/lib/newme-os-drive-sync";
  const metaIdsDir = env.META_IDS_OUT_DIR || "/var/lib/newme-meta-ids";
  const cfg = { ...DEFAULTS, metaSheetId: env.OS_DRIVE_META_SHEET_ID || DEFAULTS.metaSheetId, salesSheetId: env.OS_DRIVE_SALES_SHEET_ID || DEFAULTS.salesSheetId };
  const io = createIo(args.dryRun ? (env.OS_DRIVE_SYNC_DATA_DIR || `${process.env.TMPDIR || "/tmp"}/newme-os-drive-sync-dry`) : dataDir, metaIdsDir);
  const log = (m) => console.log(m);
  let exitCode = 1;
  try {
    const saFile = env.GOOGLE_SA_FILE || (existsSync("/etc/newme/google-sheets-sa.json") ? "/etc/newme/google-sheets-sa.json" : `${homedir()}/.config/newme/google-sheets-sa.json`);
    const sheets = createSheetsClient({ serviceAccount: loadServiceAccount(saFile), maxRequests: Number(env.OS_DRIVE_MAX_REQUESTS) || DEFAULTS.maxRequests, log });
    let osReader = null; let leadsOverride = null;
    if (args.leadsFile) leadsOverride = JSON.parse(readFileSync(args.leadsFile, "utf8"));
    else {
      const { createClient } = await import("@supabase/supabase-js");
      const url = env.NEXT_PUBLIC_SUPABASE_URL; const key = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new SyncError("db_config", "database configuration unavailable");
      osReader = createOsReader(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
    }
    const nas = createNas({ remoteDir: env.OS_DRIVE_NAS_CHANGES_DIR || "/newme-os-backup/exports/changes" });
    const result = args.reconcile
      ? await runReconcile({ osReader, sheets, io, cfg, leadsOverride })
      : await runSync({ osReader, sheets, nas, io, cfg, args, log, leadsOverride });
    console.log(JSON.stringify(result.summary));
    exitCode = result.exitCode;
  } catch (e) {
    const code = e instanceof SyncError ? e.code : "unexpected";
    console.error(`os-drive-nas-sync failed: ${code}`); // codes only: no ids, phones or key material
    if (!args.dryRun && !args.reconcile) {
      const state = io.readState(); state.consecutive_failures += 1; state.last_run_at = new Date().toISOString();
      try { io.writeState(state); } catch { /* ignore */ }
      const fatal = ["readback_mismatch", "cap_exceeded", "write_blocked", "meta_header_mismatch", "sales_header_mismatch"].includes(code);
      exitCode = fatal || shouldAlert(state.consecutive_failures) ? 1 : 0;
    } else exitCode = code === "cap_exceeded" ? 3 : 1;
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
