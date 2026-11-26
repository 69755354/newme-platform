#!/usr/bin/env node
// OS -> Google Sheets + NAS incremental push (S28). Run by newme-os-drive-sync.timer every 5 minutes.
//   node scripts/os-drive-nas-sync.mjs [--dry-run] [--reconcile] [--full] [--max-writes N] [--leads-file F]
// Default off: without OS_DRIVE_SYNC_ENABLED=true a real run does nothing. --dry-run only reads and prints
// the planned writes. See docs/s28-drive-nas-sync.md. Never prints keys, phone numbers or click ids.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync as realpathOf } from "node:fs";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMetaIdRows, leadRef } from "../src/lib/meta-ids-export.mjs";
import { createSheetsClient, loadServiceAccount } from "../src/lib/google-sheets-client.mjs";
import {
  BLUE, DEFAULTS, HEADER_NOTE, SyncError, a1Tab, assertWithinCap, buildWritePolicy, columnIndex, columnLetter, diffCellReadBack, diffReadBack, expectedFromOps,
  dubaiStamp, noteUpdated, noteWritten, dubaiDay, formatReport, guardSheets,
  maxIso, normalizeState, parseCsv, planCtwaColumnX, planMetaIdsUpsert, reconcileMetaIds, shouldAlert, sinceFromCursor,
} from "../src/lib/os-drive-sync.mjs";
import {
  REGISTER, WRITE_COLUMNS, ID_COLUMNS, checkRegisterHeader, planIdBackfill, noteBackfilled, expectedCells, fingerprintForMaster, formatOpsFor, indexRegister, planRegisterAppend, selectRegisterCandidates, buildRegisterRow,
} from "../src/lib/os-register-append.mjs";

const LEAD_COLUMNS = "id, meta_leadgen_id, ctwa_clid, campaign_id, campaign_name, adset_id, ad_id, ad_name, created_at, stage, final_status, archived, updated_at, phone";
const PAGE = 1000;
const WIDTH = columnLetter(15 - 1);
const REGISTER_LEAD_COLUMNS = "id, customer_name, phone, email, source, meta_leadgen_id, ctwa_clid, campaign_id, adset_id, ad_id, campaign_name, ad_name, created_at, archived, import_fingerprint, drive_sync:raw_import_data->drive_sync, register_append:raw_import_data->register_append";

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
    /** Leads created after the watermark (archived ones included: the planner skips them, but a half-finished append is still adopted). */
    async leadsForRegister(since) {
      return readAll(() => db.from("leads").select(REGISTER_LEAD_COLUMNS).gt("created_at", since).order("created_at", { ascending: true }).order("id", { ascending: true }), "lead_query_failed");
    },
    /** Read-only, for the one-off id backfill: every WhatsApp / click-id lead. */
    async leadsForBackfill() {
      return readAll(() => db.from("leads").select("id, source, meta_leadgen_id, ctwa_clid, campaign_id, adset_id, ad_id").or("ctwa_clid.not.is.null,source.eq.whatsapp").order("id", { ascending: true }), "lead_query_failed");
    },
    /** The only OS write of this program: remember which lead is on the register (raw_import_data.register_append; no migration). */
    async markRegisterAppended(id, info, fingerprint) {
      const cur = must(await db.from("leads").select("raw_import_data, import_fingerprint").eq("id", id).limit(1), "lead_query_failed")[0];
      if (!cur) throw new SyncError("lead_mark_failed", "lead_mark_failed");
      const raw = cur.raw_import_data && typeof cur.raw_import_data === "object" ? cur.raw_import_data : {};
      const patch = { raw_import_data: { ...raw, register_append: info } };
      if (!cur.import_fingerprint && fingerprint) patch.import_fingerprint = fingerprint; // lets the Drive -> OS sync match the row by fingerprint, not only by phone
      let r = await db.from("leads").update(patch).eq("id", id);
      if (r.error && patch.import_fingerprint) { delete patch.import_fingerprint; r = await db.from("leads").update(patch).eq("id", id); }
      if (r.error) throw new SyncError("lead_mark_failed", "lead_mark_failed");
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
    listChanges() {
      try {
        return readdirSync(join(dataDir, "changes")).filter((n) => /^\d{8}\.jsonl$/.test(n)).sort()
          .map((n) => ({ day: n.slice(0, 8), file: join(dataDir, "changes", n), size: statSync(join(dataDir, "changes", n)).size }));
      } catch { return []; }
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

/** Apply colour/note ops in one request, read the cells back (value, background, note); retry the mismatches once. */
async function applyOps(guarded, id, tab, ops, onWritten = () => {}) {
  const expected = expectedFromOps(ops);
  const readBack = async (exp) => guarded.getCells(id, exp.map((e) => `${a1Tab(tab)}!${columnLetter(e.col)}${e.row}`));
  await guarded.batchUpdateCells(id, tab, ops);
  onWritten(); // the write is on the sheet: make the audit record durable before anything else can fail
  let bad = diffCellReadBack(expected, await readBack(expected));
  if (bad.length) {
    const again = ops.filter((_, i) => bad.includes(expected[i]));
    await guarded.batchUpdateCells(id, tab, again);
    const exp2 = expectedFromOps(again);
    bad = diffCellReadBack(exp2, await readBack(exp2));
  }
  if (bad.length) throw new SyncError("readback_mismatch", `read-back mismatch on ${bad.length} cell(s) (value, colour or note) after one retry`);
}
const hashText = (t) => createHash("sha256").update(String(t)).digest("hex").slice(0, 16);

// ---------- Lead Register append (switch OS_DRIVE_REGISTER_APPEND_ENABLED) ----------
/** Read-only: header check, candidates, plan. Never throws for register problems: they are returned as {error} so the rest of the sync still runs. */
export async function planRegister({ osReader, sheets, state, args, startedAt, leadsOverride, cfg }) {
  const reg = cfg.registerSheetId; const a1 = `${a1Tab(cfg.registerTab)}!A${cfg.registerHeaderRow}:${REGISTER.lastColumn}`;
  try {
    const grid = await sheets.getValues(reg, a1);
    const head = checkRegisterHeader(grid);
    let watermark = state.register_watermark ?? null;
    let watermarkNew = false;
    if (!watermark) { if (args.dryRun) watermark = args.registerSince === "now" ? startedAt : (args.registerSince ?? null); else { watermark = startedAt; watermarkNew = true; } }
    const all = !watermark ? [] : (leadsOverride ?? await osReader.leadsForRegister(watermark));
    const sel = selectRegisterCandidates(all, watermark);
    const plan = planRegisterAppend(sel.candidates, grid, head, { maxRows: cfg.registerMaxAppend, pending: state.register_pending, allLeads: all });
    const skipped = { ...sel.skipped }; for (const [k, v] of Object.entries(plan.skipped)) skipped[k] = (skipped[k] ?? 0) + v;
    return { head, grid, plan, watermark, watermarkNew, all, skipped, over: plan.appends.length > cfg.registerMaxAppend };
  } catch (e) {
    return { error: e instanceof SyncError ? e.code : "register_read_failed" }; // never leaks sheet text
  }
}
/** Counts only: no names, phones, e-mails or sheet text. */
export function registerSummary(r, cfg) {
  if (!r) return null;
  if (r.error) return { error: r.error };
  return { watermark: r.watermark ?? "not_set_yet", candidates_new: r.plan.appends.length + r.plan.present.length, would_append: r.plan.appends.length, already_present_adopt: r.plan.present.length,
    skipped: r.skipped, dropped_pending: r.plan.droppedPending.length, over_limit: r.over ? r.plan.appends.length - cfg.registerMaxAppend : 0 };
}

async function executeRegister({ reg, guarded, policy, osReader, io, state, cfg, now, flush, changes, ts }) {
  const { head, plan } = reg; const id = cfg.registerSheetId; const tab = cfg.registerTab; const a1 = `${a1Tab(tab)}!A${cfg.registerHeaderRow}:${REGISTER.lastColumn}`;
  const out = { appended: 0, adopted: 0, marked: 0 };
  WRITE_COLUMNS.forEach((n) => policy[id].writeCols.add(columnLetter(head.index[n])));
  for (const m of plan.droppedPending) delete state.register_pending[m];
  if (plan.appends.length) {
    for (const a of plan.appends) state.register_pending[a.master] = { lead_id: a.lead.id, ref: leadRef(a.lead.id), at: new Date(now()).toISOString(), formatted: false };
    io.writeState(state); // durable BEFORE the append: a crash leaves a record of what may be on the sheet
    // Explicit rows below the last used row, written with values.update. A network error or 5xx may or may not have landed:
    // re-read, and write only what is still missing, to rows chosen again from the fresh sheet.
    let todo = plan.appends; let grid = reg.grid; let lastRow = plan.lastRow;
    for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
      const first = lastRow + 1; const last = first + todo.length - 1;
      const target = await guarded.getValues(id, `${a1Tab(tab)}!A${first}:${REGISTER.lastColumn}${last}`);
      if (target.some((r) => (r ?? []).some((v) => String(v ?? "").trim() !== ""))) throw new SyncError("register_target_not_empty", "rows below the register are not empty; nothing written");
      const data = []; todo.forEach((a, i) => { policy[id].writeRows.add(first + i); policy[id].formatRows.add(first + i); a.row.forEach((v, c) => { if (v !== "") data.push({ range: `${a1Tab(tab)}!${columnLetter(c)}${first + i}`, values: [[v]] }); }); });
      try { await guarded.batchUpdateValues(id, data); } catch (e) { if (!/^http_(network|5\d\d)$/.test(e?.code ?? "")) throw e; }
      grid = await guarded.getValues(id, a1);
      const now2 = indexRegister(grid, head, cfg.registerHeaderRow);
      todo = todo.filter((a) => !now2.byMaster.has(a.master)); lastRow = now2.lastRow;
    }
    if (todo.length) throw new SyncError("append_not_found", `${todo.length} register row(s) are not on the sheet after two attempts`);
    const idx = indexRegister(grid, head, cfg.registerHeaderRow);
    const masters = grid.slice(1).map((r) => String(r?.[head.index["Master Lead ID"]] ?? "").trim());
    for (const a of plan.appends) {
      if (masters.filter((m) => m === a.master).length !== 1) throw new SyncError("register_duplicate_after_append", "an appended Master Lead ID is on the register more than once");
      const sheetRow = idx.byMaster.get(a.master); a.sheetRow = sheetRow;
      if (sheetRow <= plan.lastRow) throw new SyncError("register_append_position", "a row landed inside existing data; stopping");
      const bad = expectedCells(a.row).filter((c) => String(grid[sheetRow - cfg.registerHeaderRow]?.[c.col] ?? "") !== c.value);
      if (bad.length) throw new SyncError("readback_mismatch", `register read-back mismatch on ${bad.length} cell(s)`);
      changes.push({ ts, sheet: "lead_register", action: "append", row: sheetRow, lead_ref: leadRef(a.lead.id), master_lead_id: a.master, columns: expectedCells(a.row).length });
    }
    flush(); out.appended = plan.appends.length;
  }
  // colour + note: freshly appended rows, plus rows of an earlier run that crashed before the format was applied
  const toFormat = [...plan.appends.map((a) => ({ ...a, ms: now() })),
    ...plan.present.filter((p) => state.register_pending[p.master] && !state.register_pending[p.master].formatted).map((p) => ({ lead: p.lead, master: p.master, sheetRow: p.sheetRow, row: buildRegisterRow(p.lead, head), ms: Date.parse(state.register_pending[p.master].at) || now() }))];
  if (toFormat.length) {
    const ops = []; const grid = await guarded.getValues(id, a1);
    for (const f of toFormat) {
      policy[id].formatRows.add(f.sheetRow);
      const cur = grid[f.sheetRow - cfg.registerHeaderRow] ?? [];
      const mine = formatOpsFor(f.sheetRow, f.row, f.ms, leadRef(f.lead.id)).filter((o) => String(cur[o.col] ?? "") === f.row[o.col]); // only cells that still hold what OS wrote
      ops.push(...mine);
    }
    if (ops.length) await applyOps(guarded, id, tab, ops, () => {});
    for (const f of toFormat) state.register_pending[f.master].formatted = true;
    io.writeState(state);
  }
  // remember in OS (adopt rows that were already there too)
  const marks = [...plan.appends.map((a) => ({ lead: a.lead, master: a.master, sheetRow: a.sheetRow })), ...plan.present];
  let markError = null;
  for (const m of marks) {
    try {
      await osReader.markRegisterAppended(m.lead.id, { master_lead_id: m.master, row: m.sheetRow, appended_at: state.register_pending[m.master]?.at ?? new Date(now()).toISOString(), by: state.register_pending[m.master] ? "os_register_append" : "found_on_register" }, fingerprintForMaster(m.master));
      delete state.register_pending[m.master]; state.register_appended_total += 1; out.marked += 1;
      if (!plan.appends.some((a) => a.master === m.master)) out.adopted += 1;
    } catch (e) { markError = e; }
  }
  io.writeState(state);
  if (markError) throw markError; // rows stay in register_pending: the next run adopts them and retries the mark
  return out;
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
    : { writes: [], unchanged: 0, unmatched: [], ambiguous: [], manual: [], ambiguousDestination: [], conflicts: 0 };
  Object.assign(summary, {
    meta_updates: planA.updates.length, meta_appends: planA.appends.length, meta_unchanged: planA.unchanged, meta_duplicate_keys: planA.duplicateSheetKeys,
    x_writes: planB.writes.length, x_manual_skipped: planB.manual.length, x_unchanged: planB.unchanged, x_unmatched: planB.unmatched.length, x_ambiguous: planB.ambiguous.length, x_ambiguous_destination: planB.ambiguousDestination.length,
  });
  // a person's value is never touched and never formatted: it is only counted, and logged once per distinct value
  const manualNew = planB.manual.filter((m) => state.x_manual_marked[m.lead_ref] !== hashText(m.current));
  // Lead Register append: read-only planning here, writes after the other stages. A register problem never stops the rest of the sync.
  const registerOn = Boolean(cfg.registerAppend || (args.dryRun && args.registerSince)); // a dry-run preview needs --register-since (or "now")
  let reg = null;
  if (registerOn) {
    if (!state.register_watermark && !args.dryRun) { state.register_watermark = startedAt; io.writeState(state); } // first enabled run: only leads created from now on
    reg = await planRegister({ osReader, sheets, state, args, startedAt, leadsOverride, cfg });
    if (!reg.error && reg.over) reg.error = "register_cap_exceeded";
    summary.register = registerSummary(reg, cfg);
  }
  const registerAppends = reg && !reg.error ? reg.plan.appends.length : 0;
  const planned = planA.updates.length + planA.appends.length + planB.writes.length + registerAppends;
  summary.planned_writes = planned;

  if (args.dryRun) {
    for (const u of planA.updates.slice(0, 5)) log(`dry-run: update Meta IDs row ${u.row}`);
    for (const w of planB.writes.slice(0, 5)) log(`dry-run: write ${cfg.clidColumn}${w.row} on ${cfg.salesTab} (${w.lead_ref})`);
    return { summary, exitCode: planned > args.maxWrites ? 3 : (reg?.error ? 1 : 0) };
  }
  assertWithinCap(planned, args.maxWrites); // throws before anything is written

  // 3. write + read back. Every stage logs what it wrote to the spool BEFORE the next thing that can fail.
  const changes = []; const ts = startedAt;
  const flush = () => { if (changes.length) io.appendChanges(day, changes.splice(0)); };
  const policy = buildWritePolicy({ ...cfg, metaTab: titles.meta, registerSheetId: registerOn ? cfg.registerSheetId : null, registerTab: cfg.registerTab, registerHeaderRow: cfg.registerHeaderRow });
  const guarded = guardSheets(sheets, policy);
  // Provenance format (blue row + notes) per Meta IDs row key, without the row number: the values may already be on
  // the sheet when the format request fails, and the next run would then plan nothing for that row. The ops are saved
  // in the state before the format write and cleared after it, so an unfinished set is replayed on the next run.
  const fmtByKey = {}; const rowByKey = new Map();
  const metaKeyOfRow = (r) => `${r?.[0] ?? ""}|${r?.[2] ?? ""}|${r?.[3] ?? ""}`;
  grids.meta.slice(1).forEach((r, i) => { if (!rowByKey.has(metaKeyOfRow(r))) rowByKey.set(metaKeyOfRow(r), i + 2); });
  const metaRange = `${a1Tab(titles.meta)}!A:${WIDTH}`;
  if (planA.updates.length) {
    const data = planA.updates.map((u) => ({ range: `${a1Tab(titles.meta)}!A${u.row}:${WIDTH}${u.row}`, values: [u.values] }));
    await guarded.batchUpdateValues(cfg.metaSheetId, data);
    for (const u of planA.updates) changes.push({ ts, sheet: "meta_ids", action: "update", row: u.row, lead_ref: u.values[0], meta_id_type: u.values[2], meta_id: u.values[3], values: u.values, previous: u.previous });
    flush();
    await verifyAndRetry(guarded, cfg.metaSheetId, data, (bad) => guarded.batchUpdateValues(cfg.metaSheetId, bad));
    for (const u of planA.updates) {
      const key = `${u.values[0]}|${u.values[2]}|${u.values[3]}`;
      rowByKey.set(key, u.row);
      const ops = [{ kind: "rowbg", c1: 0, c2: 14, bg: BLUE }];
      u.values.forEach((v, c) => { if (v !== u.previous[c]) ops.push({ kind: "cell", col: c, note: noteUpdated(now(), state.meta_times[key]) }); });
      fmtByKey[key] = ops;
      state.meta_times[key] = dubaiStamp(now());
    }
  }
  if (planA.appends.length) {
    // An append that fails with a network error or 5xx may or may not have landed. Never repeat it blindly:
    // re-read the sheet, and append only the rows whose key is still missing.
    const keyOf = (v) => `${v[0]}|${v[2]}|${v[3]}`;
    const sheetKeys = (grid) => new Map(grid.slice(1).map((r, i) => [`${r?.[0] ?? ""}|${r?.[2] ?? ""}|${r?.[3] ?? ""}`, i + 2]));
    let todo = planA.appends;
    for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
      try { await guarded.appendValues(cfg.metaSheetId, `${a1Tab(titles.meta)}!A1`, todo); } catch (e) {
        if (!/^http_(network|5\d\d)$/.test(e?.code ?? "")) throw e;
      }
      const have = sheetKeys(await guarded.getValues(cfg.metaSheetId, metaRange));
      todo = todo.filter((v) => !have.has(keyOf(v)));
    }
    if (todo.length) throw new SyncError("append_not_found", `${todo.length} appended row(s) are not on the sheet after two attempts`);
    const grid = await guarded.getValues(cfg.metaSheetId, metaRange); const rowOf = sheetKeys(grid);
    for (const v of planA.appends) changes.push({ ts, sheet: "meta_ids", action: "append", row: rowOf.get(keyOf(v)), lead_ref: v[0], meta_id_type: v[2], meta_id: v[3], values: v });
    flush();
    const bad = planA.appends.filter((v) => { const r = grid[rowOf.get(keyOf(v)) - 1] ?? []; return v.some((x, c) => String(r[c] ?? "") !== x); });
    if (bad.length) throw new SyncError("readback_mismatch", "read-back mismatch after append");
    for (const v of planA.appends) {
      rowByKey.set(keyOf(v), rowOf.get(keyOf(v)));
      fmtByKey[keyOf(v)] = [{ kind: "rowbg", c1: 0, c2: 14, bg: BLUE }, { kind: "cell", col: 0, note: noteUpdated(now(), null) }];
      state.meta_times[keyOf(v)] = dubaiStamp(now());
    }
  }
  // replay what an earlier run could not finish (this run's own ops for the same row win; a row no longer on the sheet is dropped)
  for (const [key, ops] of Object.entries(state.pending_meta_format)) if (!fmtByKey[key] && rowByKey.has(key)) fmtByKey[key] = ops;
  const metaOps = Object.entries(fmtByKey).flatMap(([key, ops]) => ops.map((o) => ({ ...o, row: rowByKey.get(key) })));
  if (!state.meta_header_noted) metaOps.push({ kind: "headernote", row: 1, col: 0, note: HEADER_NOTE });
  if (metaOps.length) {
    state.pending_meta_format = fmtByKey; io.writeState(state); // durable before the format write can fail
    await applyOps(guarded, cfg.metaSheetId, titles.meta, metaOps, () => {
      if (!state.meta_header_noted) { state.meta_header_noted = true; changes.push({ ts, sheet: "meta_ids", action: "header_note", row: 1 }); flush(); }
    });
    state.pending_meta_format = {};
    io.writeState(state); // meta_times / header flag are facts about the sheet now; the cursor is not moved here
  }
  if (planB.writes.length) {
    const col = columnIndex(cfg.clidColumn); const nowMs = now();
    const ops = planB.writes.map((w) => ({ kind: "cell", row: w.row, col, value: w.value, bg: BLUE, note: noteWritten(nowMs, w.lead_ref) }));
    await applyOps(guarded, cfg.salesSheetId, cfg.salesTab, ops, () => {
      for (const w of planB.writes) { changes.push({ ts, sheet: "home_owners_x", action: "write", row: w.row, lead_ref: w.lead_ref, value: w.value, note: noteWritten(nowMs, w.lead_ref) }); state.x_written[w.lead_ref] = w.value; delete state.x_manual_marked[w.lead_ref]; }
      flush(); io.writeState(state);
    });
  }
  // no sheet write for these: only the NAS log (no cell text) and a hash in the state so each value is logged once
  for (const m of manualNew) { changes.push({ ts, sheet: "home_owners_x", action: "skipped_manual_value", row: m.row, lead_ref: m.lead_ref, edited_after_os_write: m.edited }); state.x_manual_marked[m.lead_ref] = hashText(m.current); }
  for (const a of planB.ambiguousDestination) changes.push({ ts, sheet: "home_owners_x", action: "skipped_ambiguous_destination", row: a.row, lead_ref: a.lead_ref });
  flush();

  let registerError = reg?.error ?? null;
  if (reg && !reg.error && (reg.plan.appends.length || reg.plan.present.length || reg.plan.droppedPending.length)) {
    try { Object.assign(summary.register, { done: await executeRegister({ reg, guarded, policy, osReader, io, state, cfg, now, flush, changes, ts }) }); } catch (e) { flush(); registerError = e instanceof SyncError ? e.code : "register_unexpected"; if (e?.code === "readback_mismatch" || e?.code === "write_blocked") throw e; }
  }
  if (registerError) summary.register = { ...(summary.register ?? {}), error: registerError };

  // 4. NAS upload: every day's spool that the NAS has not confirmed (a failed day is retried after midnight too)
  let nasError = null;
  for (const spool of io.listChanges()) {
    if (state.nas_uploaded[spool.day] === spool.size) continue;
    try { await nas.upload(spool.file); state.nas_uploaded[spool.day] = spool.size; } catch (e) { nasError = e; }
  }

  // 5. cursor + pending list, saved last
  const seenAt = maxIso(...leads.map((l) => l.updated_at), state.leads_cursor);
  state.leads_cursor = seenAt ?? state.leads_cursor ?? startedAt;
  const pendingNow = { ...state.pending_ctwa };
  for (const l of ctwaLeads) delete pendingNow[idByRef.get(l.lead_ref)];
  const stillOpen = new Set([...planB.unmatched.filter((u) => u.reason === "no_row").map((u) => u.lead_ref), ...planB.ambiguous.map((a) => a.lead_ref), ...planB.ambiguousDestination.map((a) => a.lead_ref)]);
  // a retried lead keeps the time it FIRST went pending, so the pendingDays expiry below can fire
  for (const ref of stillOpen) { const id = idByRef.get(ref); pendingNow[id] = state.pending_ctwa[id] ?? startedAt; }
  for (const [id, first] of Object.entries(pendingNow)) if (now() - Date.parse(first) > cfg.pendingDays * 86_400_000) delete pendingNow[id];
  state.pending_ctwa = pendingNow;
  state.last_run_at = startedAt;
  // a failed NAS upload is a failed run for health: last_ok_at stays, the failure counter goes up
  if (nasError) state.consecutive_failures += 1; else { state.last_ok_at = startedAt; state.consecutive_failures = 0; }
  io.writeState(state);
  summary.nas_error = nasError ? nasError.code : null;
  summary.requests = sheets.requestCount ?? null;
  return { summary, exitCode: nasError || registerError ? 1 : 0 };
}

// ---------- one-off: fill empty AK..AN on WA-NM- rows of the Lead Register (dry-run unless args.execute) ----------
export async function runRegisterIdBackfill({ osReader, sheets, io, cfg = DEFAULTS, args = {}, now = () => Date.now(), leadsOverride = null }) {
  const id = cfg.registerSheetId; const tab = cfg.registerTab; const a1 = `${a1Tab(tab)}!A${cfg.registerHeaderRow}:${REGISTER.lastColumn}`;
  const grid = await sheets.getValues(id, a1);
  const head = checkRegisterHeader(grid);
  const leads = leadsOverride ?? await osReader.leadsForBackfill();
  const plan = planIdBackfill(grid, head, leads, cfg.registerHeaderRow);
  const summary = { mode: args.execute ? "execute" : "dry_run", rows: plan.rows.length, cells: plan.cells.length, skipped: plan.skipped, written: 0 };
  if (!args.execute || !plan.cells.length) return { summary, exitCode: 0 };
  assertWithinCap(plan.cells.length, args.maxWrites ?? cfg.maxWrites);
  const policy = buildWritePolicy({ ...cfg, metaTab: "-", registerSheetId: id, registerTab: tab, registerHeaderRow: cfg.registerHeaderRow });
  const guarded = guardSheets(sheets, policy);
  const rule = policy[id];
  ID_COLUMNS.forEach((n) => rule.writeCols.add(columnLetter(head.index[n])));
  plan.rows.forEach((r) => { rule.writeRows.add(r); rule.formatRows.add(r); });
  // re-read right before writing: a cell somebody filled in meanwhile is never overwritten
  const fresh = await guarded.getValues(id, a1);
  const todo = plan.cells.filter((c) => String(fresh[c.row - cfg.registerHeaderRow]?.[c.col] ?? "").trim() === "");
  if (!todo.length) return { summary, exitCode: 0 };
  const data = todo.map((c) => ({ range: `${a1Tab(tab)}!${columnLetter(c.col)}${c.row}`, values: [[c.value]] }));
  await guarded.batchUpdateValues(id, data);
  const ts = new Date(now()).toISOString();
  io.appendChanges(dubaiDay(now()), todo.map((c) => ({ ts, sheet: "lead_register", action: "backfill_ids", row: c.row, lead_ref: c.ref, column: c.name })));
  const back = await guarded.getValues(id, a1);
  const bad = todo.filter((c) => String(back[c.row - cfg.registerHeaderRow]?.[c.col] ?? "") !== c.value);
  if (bad.length) throw new SyncError("readback_mismatch", `register read-back mismatch on ${bad.length} cell(s)`);
  await applyOps(guarded, id, tab, todo.map((c) => ({ kind: "cell", row: c.row, col: c.col, bg: BLUE, note: noteBackfilled(now(), c.ref) })), () => {});
  summary.written = todo.length;
  return { summary, exitCode: 0 };
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
  let x = null; let overdueWrites = 0;
  const updatedByRef = new Map(leads.map((l) => [leadRef(l.id), Date.parse(l.updated_at)]));
  if (grids.sales) {
    const p = planCtwaColumnX(grids.sales.phoneCol, grids.sales.clidCol, ctwa, cfg, io.readState().x_written);
    // a column X write still missing 60+ minutes after the lead last changed is a real gap: the 5-minute worker only looks at recent leads
    overdueWrites = p.writes.filter((w) => !(now() - (updatedByRef.get(w.lead_ref) ?? 0) < 60 * 60_000)).length;
    x = { os_leads_with_click_id: ctwa.length, already_in_sheet: p.unchanged, would_write: p.writes.length, unmatched: p.unmatched.length, ambiguous: p.ambiguous.length, ambiguous_destination: p.ambiguousDestination.length, manual_value_skipped: p.manual.length };
  }
  const state = io.readState();
  const ageMin = state.last_ok_at ? Math.round((now() - Date.parse(state.last_ok_at)) / 60_000) : null;
  const nasUnconfirmed = io.listChanges().filter((s) => state.nas_uploaded[s.day] !== s.size).length;
  const health = { last_ok_minutes_ago: ageMin ?? "never", consecutive_failures: state.consecutive_failures, pending_unmatched_click_ids: Object.keys(state.pending_ctwa).length, overdue_x_writes: overdueWrites, nas_unconfirmed_spool_days: nasUnconfirmed };
  const stale = ageMin === null || ageMin > 60 || state.consecutive_failures >= 3;
  // Real data-loss conditions only (Meta registry row/NAS mismatch, a stalled or repeatedly failing worker = write failures, unconfirmed NAS days) exit non-zero.
  // Click ids that cannot be matched into column X (no sheet row, ambiguous rows, hand-filled cells, a fresh write the 5-minute worker has not made yet (older than 60 min = drift), pending retries) are WARNINGS:
  // listed in the report and the log, exit 0 (S45: they made the nightly unit fail every night while all row counts agreed).
  const drift = meta.drift || stale || nasUnconfirmed > 0 || overdueWrites > 0;
  const warnings = [];
  if (x) {
    const parts = [["unmatched", x.unmatched], ["ambiguous", x.ambiguous], ["ambiguous_destination", x.ambiguous_destination], ["manual_value_skipped", x.manual_value_skipped], ["would_write", x.would_write]].filter(([, n]) => n > 0);
    if (parts.length) warnings.push(`WARNING: some click ids are not matched into column X (${parts.map(([k, n]) => `${k}=${n}`).join(", ")}); not a data-loss condition, exit code unaffected.`);
  }
  if (health.pending_unmatched_click_ids > 0) warnings.push(`WARNING: ${health.pending_unmatched_click_ids} click id(s) still pending a sheet row (retried by the worker, expire automatically).`);
  const notes = [...(drift ? ["Drift found: the 5-minute worker normally closes it; if it persists, check the worker log."] : []), ...warnings];
  const text = formatReport({ day, mode: drift ? "DRIFT" : warnings.length ? "ok (with warnings)" : "ok", meta, ctwa: x, health, notes });
  for (const w of warnings) console.warn(w);
  const file = io.writeReport(day, text);
  return { summary: { ...meta, drift, warnings: warnings.length, report: file }, exitCode: drift ? 1 : 0 }; // overall drift, not only the Meta-sheet part
}

// ---------- CLI ----------
export function parseArgs(argv) {
  const out = { dryRun: false, reconcile: false, full: false, maxWrites: DEFAULTS.maxWrites, leadsFile: null, registerSince: null, backfillRegisterIds: false, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--reconcile") out.reconcile = true;
    else if (a === "--full") out.full = true;
    else if (a === "--max-writes") out.maxWrites = Number(argv[++i]);
    else if (a === "--leads-file") out.leadsFile = argv[++i];
    else if (a === "--backfill-register-ids") out.backfillRegisterIds = true; // one-off: fill empty AK..AN on WA-NM- register rows (dry-run unless --execute)
    else if (a === "--execute") out.execute = true;
    else if (a === "--register-since") out.registerSince = argv[++i]; // dry-run preview only: leads created after this ISO time
    else throw new SyncError("usage", `unknown argument ${a}`);
  }
  if (!Number.isInteger(out.maxWrites) || out.maxWrites < 0) throw new SyncError("usage", "--max-writes needs a non-negative integer");
  if (out.execute && !out.backfillRegisterIds) throw new SyncError("usage", "--execute only goes with --backfill-register-ids");
  if (out.registerSince !== null && out.registerSince !== "now" && !Number.isFinite(Date.parse(out.registerSince))) throw new SyncError("usage", "--register-since needs an ISO time");
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\nUsage: os-drive-nas-sync.mjs [--dry-run] [--reconcile] [--full] [--max-writes N] [--leads-file F] [--register-since ISO|now] [--backfill-register-ids [--execute]]`); process.exit(2); }
  const env = process.env;
  if (!args.dryRun && env.OS_DRIVE_SYNC_ENABLED !== "true") { console.log("OS_DRIVE_SYNC_ENABLED is not true: nothing to do"); return; }
  const dataDir = env.OS_DRIVE_SYNC_DATA_DIR || "/var/lib/newme-os-drive-sync";
  const metaIdsDir = env.META_IDS_OUT_DIR || "/var/lib/newme-meta-ids";
  const cfg = { ...DEFAULTS, metaSheetId: env.OS_DRIVE_META_SHEET_ID || DEFAULTS.metaSheetId, salesSheetId: env.OS_DRIVE_SALES_SHEET_ID || DEFAULTS.salesSheetId,
    registerAppend: env.OS_DRIVE_REGISTER_APPEND_ENABLED === "true", registerSheetId: env.OS_DRIVE_REGISTER_SHEET_ID || DEFAULTS.registerSheetId };
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
      const url = env.NEXT_PUBLIC_SUPABASE_URL;
      const key = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new SyncError("db_config", "database configuration unavailable");
      osReader = createOsReader(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
    }
    const nas = createNas({ remoteDir: env.OS_DRIVE_NAS_CHANGES_DIR || "/newme-os-backup/exports/changes" });
    const result = args.backfillRegisterIds
      ? await runRegisterIdBackfill({ osReader, sheets, io, cfg, args, leadsOverride })
      : args.reconcile
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
      const fatal = ["readback_mismatch", "cap_exceeded", "write_blocked", "meta_header_mismatch", "sales_header_mismatch", "register_header_mismatch"].includes(code);
      exitCode = fatal || shouldAlert(state.consecutive_failures) ? 1 : 0;
    } else exitCode = code === "cap_exceeded" ? 3 : 1;
  }
  process.exitCode = exitCode;
}

// Main-module test by real path: systemd, cron and the Hermes scripts start this by the /opt/newme/current symlink, and Node
// reports import.meta.url as the resolved release directory, so comparing the unresolved argv[1] never matched there.
const isMainModule = () => { try { return Boolean(process.argv[1]) && realpathOf(process.argv[1]) === realpathOf(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMainModule()) await main();
