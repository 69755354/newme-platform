// Lead Register append (S28 extension). Fake Sheets + fake OS reader: no network, no database, no Drive access.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { META_IDS_HEADER } from "../../src/lib/meta-ids-export.mjs";
import { SyncError, BLUE, DEFAULTS, buildWritePolicy, columnIndex, columnLetter, guardSheets } from "../../src/lib/os-drive-sync.mjs";
import { REGISTER_HEADER, WRITE_COLUMNS, masterLeadId, selectRegisterCandidates, checkRegisterHeader } from "../../src/lib/os-register-append.mjs";
import { buildIndexes, decideChange } from "../../src/lib/drive-sync.mjs";
import { SOURCES, buildChanges, toTab } from "../../scripts/lib/drive-sync-sources.mjs";
import { createIo, runSync } from "../../scripts/os-drive-nas-sync.mjs";

const META = DEFAULTS.metaSheetId; const SALES = DEFAULTS.salesSheetId; const REG = DEFAULTS.registerSheetId;
const A1 = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/;

/** In-memory spreadsheets. grids[id] = array of rows (strings). Records every write range. */
function fakeSheets(grids, titles = { [META]: "Registry", [SALES]: "Home-owners" }) {
  const writes = []; let requests = 0; const fmt = {}; const inject = { append: null };
  const parse = (range) => {
    const bang = range.lastIndexOf("!"); const a1 = range.slice(bang + 1);
    const m = a1.match(A1); const c1 = columnIndex(m[1]); const c2 = columnIndex(m[3] ?? m[1]);
    const r1 = m[2] ? Number(m[2]) : 1; const r2 = m[3] !== undefined ? (m[4] ? Number(m[4]) : Infinity) : (m[2] ? r1 : Infinity);
    return { c1, c2, r1, r2 };
  };
  const read = (id, range) => {
    const { c1, c2, r1, r2 } = parse(range); const g = grids[id]; const out = [];
    for (let r = r1; r <= Math.min(r2, g.length); r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(g[r - 1]?.[c] ?? ""); while (row.length && row[row.length - 1] === "") row.pop(); out.push(row); }
    return out;
  };
  const put = (id, range, values) => {
    const { c1, r1 } = parse(range); const g = grids[id];
    values.forEach((vals, i) => { while (g.length < r1 + i) g.push([]); vals.forEach((v, j) => { g[r1 + i - 1][c1 + j] = String(v); }); });
  };
  return {
    writes, grids, fmt, inject, get requestCount() { return requests; },
    async getFirstSheetTitle(id) { requests++; return titles[id]; },
    async getValues(id, range) { requests++; return read(id, range); },
    async batchGetValues(id, ranges) { requests++; return ranges.map((r) => read(id, r)); },
    async batchUpdateValues(id, data) { requests++; for (const d of data) { writes.push({ id, range: d.range }); put(id, d.range, d.values); } return {}; },
    async getSheetId() { requests++; return 7; },
    async batchUpdateCells(id, tab, ops) {
      requests++;
      for (const o of ops) {
        if (o.kind === "rowbg") { writes.push({ id, range: `'${tab}'!${columnLetter(o.c1)}${o.row}:${columnLetter(o.c2)}${o.row}`, format: true }); for (let c = o.c1; c <= o.c2; c++) (fmt[`${id}:${o.row},${c}`] ??= {}).bg = o.bg; continue; }
        writes.push({ id, range: `'${tab}'!${columnLetter(o.col)}${o.row}`, format: true });
        const f = (fmt[`${id}:${o.row},${o.col}`] ??= {});
        if (o.kind === "headernote") { f.note = o.note; continue; }
        if (o.value !== undefined) put(id, `'${tab}'!${columnLetter(o.col)}${o.row}`, [[o.value]]);
        if (o.bg) f.bg = o.bg; if (o.note !== undefined) f.note = o.note;
      }
      return {};
    },
    async getCells(id, ranges) {
      requests++;
      return ranges.map((r) => { const { c1, r1 } = parse(r); const f = fmt[`${id}:${r1},${c1}`] ?? {}; return { value: grids[id][r1 - 1]?.[c1] ?? "", bg: f.bg ?? null, note: f.note ?? "" }; });
    },
    async appendValues(id, range, values) {
      requests++; const g = grids[id];
      if (inject.append === "lost") { inject.append = null; throw new SyncError("http_network", "lost before the sheet saw it"); }
      if (inject.append === "landed") { inject.append = null; values.forEach((v) => g.push([...v])); throw new SyncError("http_network", "landed but the answer was lost"); } const start = g.length + 1; values.forEach((v) => g.push([...v])); writes.push({ id, range: `append:${range}`, rows: values.length });
      return { updates: { updatedRange: `'${titles[id]}'!A${start}:O${start + values.length - 1}` } };
    },
  };
}
const salesGrid = () => [[...Array(15).fill("a"), "phone", ...Array(7).fill("b"), "meta_wa_ctwa_clid"].map((v, i) => (i === 15 ? "phone" : i === 23 ? "meta_wa_ctwa_clid" : v))];
const HEAD = [...REGISTER_HEADER, "Column 39"];
const col = (n) => HEAD.indexOf(n);
const regRow = (o) => HEAD.map((h) => o[h] ?? "");
const regGrid = (rows = [], head = HEAD) => [[], [], [], [], [...head], ...rows]; // banner rows 1-4, header on row 5
const TITLES = { [META]: "Registry", [SALES]: "Home-owners", [REG]: "Lead Register" };
const NOW = Date.parse("2026-11-20T10:00:00Z");
const world = (rows = [], head = HEAD) => fakeSheets({ [META]: [[...META_IDS_HEADER]], [SALES]: salesGrid(), [REG]: regGrid(rows, head) }, TITLES);

const lead = (n, extra = {}) => ({ id: `0000000${n}-aaaa-0000-0000-000000000000`, customer_name: `Test Person ${n}`, phone: `+97150111000${n}`, email: `t${n}@example.invalid`, source: "website",
  meta_leadgen_id: null, ctwa_clid: null, campaign_name: "Camp", ad_name: "Ad", created_at: "2026-11-20T11:00:00.000Z", updated_at: "2026-11-20T11:00:00.000Z", archived: false,
  import_fingerprint: null, drive_sync: null, register_append: null, stage: "new", final_status: "", ...extra });
function osReader(leads) {
  const calls = { marks: [], failMark: 0 };
  return { calls,
    async leadsChangedSince() { return []; }, async leadIdsWithEventsSince() { return []; }, async leadsByIds() { return []; },
    async eventsForLeads() { return { formEvents: [], whatsappEvents: [] }; },
    async leadsForRegister(since) { return leads.filter((l) => Date.parse(l.created_at) > Date.parse(since)); },
    async markRegisterAppended(id, info, fp) {
      if (calls.failMark > 0) { calls.failMark--; throw new SyncError("lead_mark_failed"); }
      const l = leads.find((x) => x.id === id); l.register_append = info; if (!l.import_fingerprint) l.import_fingerprint = fp; calls.marks.push(id);
    } };
}
const nas = { async upload() {} };
const mk = () => createIo(mkdtempSync(join(tmpdir(), "reg-")), join(tmpdir(), "none"));
const cfgOn = { ...DEFAULTS, registerAppend: true };
const run = (sheets, reader, io, { now = NOW, cfg = cfgOn, args = {} } = {}) => runSync({ osReader: reader, sheets, nas, io, cfg, args: { maxWrites: 200, ...args }, now: () => now, log: () => {} });
const regWrites = (sheets) => sheets.writes.filter((w) => w.id === REG);
const appended = (sheets) => sheets.grids[REG].slice(5);

test("switch off: nothing is read from or written to the register", async () => {
  const sheets = world(); const io = mk();
  const r = await run(sheets, osReader([lead(1)]), io, { cfg: DEFAULTS });
  assert.equal(r.summary.register, undefined); assert.equal(regWrites(sheets).length, 0); assert.equal(io.readState().register_watermark, null);
});

test("header mismatch: refuses to write the register, the rest of the sync still runs", async () => {
  const bad = [...HEAD]; bad[col("Primary phone")] = "Phone";
  for (const head of [bad, HEAD.filter((h) => h !== "Master Lead ID"), [...HEAD.slice(0, 3).reverse(), ...HEAD.slice(3)]]) {
    const sheets = world([], head); const io = mk(); const rd = osReader([lead(1, { created_at: "2026-11-20T11:00:00.000Z" })]);
    io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
    const r = await run(sheets, rd, io);
    assert.equal(r.summary.register.error, "register_header_mismatch"); assert.equal(r.exitCode, 1);
    assert.equal(regWrites(sheets).length, 0); assert.equal(rd.calls.marks.length, 0);
  }
});

test("header check accepts extra trailing / blank columns but needs every name once, in order", () => {
  assert.doesNotThrow(() => checkRegisterHeader([[...HEAD.slice(0, 5), "", ...HEAD.slice(5), "Extra"]]));
  assert.throws(() => checkRegisterHeader([[...HEAD, "Master Lead ID"]]), (e) => e.code === "register_header_mismatch");
});

test("watermark: first enabled run only sets it; old leads are never backfilled; later leads are appended", async () => {
  const sheets = world(); const io = mk();
  const old = lead(1, { created_at: "2026-11-19T08:00:00.000Z" }); const rd = osReader([old]);
  const r1 = await run(sheets, rd, io);
  assert.equal(io.readState().register_watermark, new Date(NOW).toISOString());
  assert.equal(r1.summary.register.would_append, 0); assert.equal(regWrites(sheets).length, 0);
  const fresh = lead(2, { created_at: "2026-11-20T10:03:00.000Z" }); const rd2 = osReader([old, fresh]);
  const r2 = await run(sheets, rd2, io, { now: NOW + 300_000 });
  assert.equal(r2.exitCode, 0); assert.equal(appended(sheets).length, 1);
  assert.equal(appended(sheets)[0][col("Master Lead ID")], masterLeadId(fresh));
  assert.equal(rd2.calls.marks.length, 1); assert.equal(old.register_append, null);
  // the pure rule: not at the watermark, not before it, not archived, not sheet-born
  const sel = selectRegisterCandidates([lead(3, { created_at: "2026-11-20T10:00:00.000Z" }), lead(4, { archived: true }), lead(5, { import_fingerprint: "x" }), lead(6, { drive_sync: { inserted_by: "drive_sync" } }), lead(7, { source: "show_room" }), lead(8, { phone: "", email: "" }), lead(9)], "2026-11-20T10:00:00.000Z");
  assert.equal(sel.candidates.length, 1); assert.equal(sel.skipped.before_watermark, 1); assert.equal(sel.skipped.archived, 1);
});

test("only the intake columns are written, with Dubai received time and channel; all other cells stay empty", async () => {
  const sheets = world(); const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  await run(sheets, osReader([lead(1, { source: "fb", meta_leadgen_id: "123456789012345" })]), io);
  const row = appended(sheets)[0];
  assert.equal(row[col("Master Lead ID")], "META-123456789012345"); assert.equal(row[col("Received at")], "2026-11-20 15:00"); assert.equal(row[col("Intake channel")], "FB Form");
  assert.equal(row[col("Client")], "Test Person 1"); assert.equal(row[col("Campaign")], "Camp");
  const written = new Set(WRITE_COLUMNS.map(col));
  row.forEach((v, c) => { if (!written.has(c)) assert.equal(v ?? "", "", `column ${HEAD[c]} must stay empty`); });
  for (const h of ["Assigned to", "Dispatch status", "Routing note", "Lead quality", "Next action", "Test record"]) assert.equal(row[col(h)] ?? "", "");
});

test("provenance: every written cell is light blue with the OS note, nothing else is marked", async () => {
  const sheets = world(); const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  const l = lead(1); await run(sheets, osReader([l]), io);
  const written = new Set(WRITE_COLUMNS.map(col));
  for (let c = 0; c < HEAD.length; c++) {
    const f = sheets.fmt[`${REG}:6,${c}`];
    if (written.has(c) && appended(sheets)[0][c]) { assert.deepEqual(f.bg, BLUE); assert.match(f.note, /^OS 写入 迪拜时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}｜来源：OS｜线索 NM-[0-9a-f]{4}\*{4}$/); } else assert.equal(f, undefined, `column ${HEAD[c]} must not be formatted`);
  }
  assert.ok(!JSON.stringify(sheets.fmt).includes("Test Person") && !JSON.stringify(sheets.fmt).includes("+9715"));
});

test("dedupe: by Master Lead ID (adopted, not appended), by phone, by Meta lead id, inside one batch", async () => {
  const a = lead(1); const b = lead(2); const c = lead(3, { phone: "+971 50 111 0003" }); const d = lead(4, { source: "fb", meta_leadgen_id: "555555555555", phone: "+971509990004" });
  const dupBatch = lead(5, { phone: "050 111 0006", created_at: "2026-11-20T11:01:00.000Z" }); const dupBatch2 = lead(6, { phone: "+971501110006", created_at: "2026-11-20T11:02:00.000Z" });
  const sheets = world([
    regRow({ "Master Lead ID": masterLeadId(a), "Primary phone": "+971500000000" }),            // key present, other phone
    regRow({ "Master Lead ID": "LEGACY-77", "Primary phone": "p:+971501110002" }),               // phone of b under a different key
    regRow({ "Master Lead ID": "LEGACY-78", "Source lead ID": "l:555555555555", "Primary phone": "000" }), // leadgen of d in source id
  ]);
  const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  const rd = osReader([a, b, c, d, dupBatch, dupBatch2]);
  const r = await run(sheets, rd, io);
  assert.equal(r.summary.register.already_present_adopt, 1);
  assert.deepEqual(sheets.grids[REG].slice(8).map((x) => x[col("Master Lead ID")]).sort(), [masterLeadId(c), masterLeadId(dupBatch)].sort()); // c: "+971 50 111 0003" is NOT on the sheet -> appended
  assert.equal(r.summary.register.skipped.phone_in_register, 1); assert.equal(r.summary.register.skipped.meta_id_in_register, 1); assert.equal(r.summary.register.skipped.duplicate_in_batch, 1);
  assert.ok(a.register_append?.row === 6); // the row already there was adopted: marked in OS, no new row
});

test("idempotent: a second run, a crash after the append, and a lost append answer never create a second row", async () => {
  const sheets = world(); const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  const l1 = lead(1); const l2 = lead(2); const rd = osReader([l1, l2]); rd.calls.failMark = 1; // OS mark fails once, after the sheet already has the row
  const r1 = await run(sheets, rd, io);
  assert.equal(r1.exitCode, 1); assert.equal(r1.summary.register.error, "lead_mark_failed"); assert.equal(appended(sheets).length, 2);
  assert.ok(Object.keys(io.readState().register_pending).length >= 1);
  const r2 = await run(sheets, rd, io, { now: NOW + 300_000 });
  assert.equal(r2.exitCode, 0); assert.equal(appended(sheets).length, 2); assert.equal(rd.calls.marks.length, 2); assert.deepEqual(io.readState().register_pending, {});
  const before = sheets.writes.length; await run(sheets, rd, io, { now: NOW + 600_000 });
  assert.equal(sheets.writes.slice(before).filter((w) => w.id === REG).length, 0);
  // append whose answer is lost although the row landed
  const s2 = world(); const io2 = mk(); io2.writeState({ ...io2.readState(), register_watermark: "2026-11-20T09:00:00.000Z" }); { const orig = s2.batchUpdateValues; let once = true; s2.batchUpdateValues = async (i, d) => { const r = await orig(i, d); if (i === REG && once) { once = false; throw new SyncError("http_network", "answer lost"); } return r; }; }
  const l3 = lead(3); const r3 = await run(s2, osReader([l3]), io2);
  assert.equal(r3.exitCode, 0); assert.equal(s2.grids[REG].slice(5).length, 1);
});

test("crash between append and colour: the next run colours the row once and marks the lead", async () => {
  const sheets = world(); const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  const l = lead(1); const rd = osReader([l]);
  const orig = sheets.batchUpdateCells; let boom = true;
  sheets.batchUpdateCells = async (id, tab, ops) => { if (id === REG && boom) { boom = false; throw new SyncError("http_network", "down"); } return orig(id, tab, ops); };
  const r1 = await run(sheets, rd, io); assert.equal(r1.exitCode, 1); assert.equal(appended(sheets).length, 1); assert.equal(sheets.fmt[`${REG}:6,0`], undefined);
  const r2 = await run(sheets, rd, io, { now: NOW + 300_000 });
  assert.equal(r2.exitCode, 0); assert.equal(appended(sheets).length, 1); assert.deepEqual(sheets.fmt[`${REG}:6,${col("Master Lead ID")}`].bg, BLUE); assert.equal(l.register_append.row, 6);
});

test("round trip: the S29 matcher finds the appended row's OS lead; no duplicate lead would be inserted", async () => {
  const leads = [lead(1, { source: "fb", meta_leadgen_id: "123456789012345" }), lead(2, { source: "whatsapp", ctwa_clid: "CLID_x_abcdefghij", phone: "050 111 0002" }), lead(3, { source: "website", phone: "+971 50 111 0003" })];
  const sheets = world(); const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  await run(sheets, osReader(leads), io);
  assert.equal(appended(sheets).length, 3);
  const src = SOURCES.find((s) => s.key === "lead_register");
  const tab = toTab(src, sheets.grids[REG].slice(4).map((r) => [...r, ...Array(Math.max(0, HEAD.length - r.length)).fill("")]));
  assert.deepEqual(tab.missing, []);
  const changes = buildChanges({ lead_register: tab }, {});
  assert.equal(changes.length, 3);
  const cfg = { allowInsert: true, allowUnarchive: false, writeNextDate: false };
  for (const withFingerprint of [true, false]) {
    const osLeads = leads.map((l) => ({ id: l.id, phone: l.phone, email: l.email, meta_leadgen_id: l.meta_leadgen_id, import_fingerprint: withFingerprint ? l.import_fingerprint : null, archived: false, stage: "new", updated_at: l.updated_at, drive_sync: null }));
    if (withFingerprint) assert.ok(osLeads.every((l) => l.import_fingerprint), "OS lead carries the fingerprint of its Master Lead ID");
    const idx = buildIndexes(osLeads);
    for (const ch of changes) {
      assert.ok(!ch.hold_reason, `S29 must understand ${ch.key.slice(0, 3)}- prefix`);
      const d = decideChange(ch, idx, cfg);
      assert.notEqual(d.action, "insert", "a duplicate lead would have been created");
      assert.ok(osLeads.some((l) => l.id === d.lead_id), "matched an OS lead");
    }
    const byKey = Object.fromEntries(changes.map((c) => [c.key, decideChange(c, idx, cfg).lead_id]));
    assert.equal(byKey[masterLeadId(leads[0])], leads[0].id); assert.equal(byKey[masterLeadId(leads[1])], leads[1].id); assert.equal(byKey[masterLeadId(leads[2])], leads[2].id);
  }
});

test("write whitelist: only the 8 write columns of empty rows chosen by the worker; no edits, no append, no other tab, no wide formats", async () => {
  const sheets = world([regRow({ "Master Lead ID": "LEGACY-1" })]); const policy = buildWritePolicy({ ...DEFAULTS, metaTab: "Registry", registerSheetId: REG, registerTab: "Lead Register", registerHeaderRow: 5 });
  const g = guardSheets(sheets, policy); const blocked = (f) => assert.rejects(Promise.resolve().then(f), (e) => e.code === "write_blocked");
  const w = (range) => g.batchUpdateValues(REG, [{ range, values: [["x"]] }]);
  await blocked(() => w("'Lead Register'!A6")); // not chosen yet
  policy[REG].writeRows.add(7); policy[REG].formatRows.add(7); policy[REG].writeCols.add("A"); policy[REG].writeCols.add("D");
  await blocked(() => w("'Lead Register'!A6")); // existing row
  await blocked(() => w("'Lead Register'!B7")); // not a write column
  await blocked(() => w("'Lead Register'!A7:D7")); // not a single cell
  await blocked(() => w("'Other tab'!A7"));
  await blocked(() => g.appendValues(REG, "'Lead Register'!A5", [["x"]])); // values.append is never allowed
  await blocked(() => g.batchUpdateCells(REG, "Lead Register", [{ kind: "cell", row: 6, col: 0, bg: BLUE, note: "n" }]));
  await blocked(() => g.batchUpdateCells(REG, "Lead Register", [{ kind: "cell", row: 7, col: 1, bg: BLUE, note: "n" }])); // not a write column
  await blocked(() => g.batchUpdateCells(REG, "Lead Register", [{ kind: "cell", row: 7, col: 0, value: "x", bg: BLUE }]));
  await blocked(() => g.batchUpdateCells(REG, "Lead Register", [{ kind: "rowbg", row: 7, c1: 0, c2: 3, bg: BLUE }]));
  await blocked(() => g.batchUpdateCells(REG, "Lead Register", [{ kind: "headernote", row: 1, col: 0, note: "n" }]));
  await w("'Lead Register'!A7"); await w("'Lead Register'!D7");
  await g.batchUpdateCells(REG, "Lead Register", [{ kind: "cell", row: 7, col: 3, bg: BLUE, note: "n" }]);
  const noRegister = buildWritePolicy({ ...DEFAULTS, metaTab: "Registry", registerSheetId: null }); assert.equal(noRegister[REG], undefined);
  await blocked(() => guardSheets(sheets, noRegister).batchUpdateValues(REG, [{ range: "'Lead Register'!A7", values: [["x"]] }]));
});

test("no values.append, last row = last row with ANY cell, non-empty target refused, Instagram form lead is FB Form", async () => {
  // sparse register: last used row is 12 (only a far column filled), blank rows inside
  const rows = [regRow({ "Master Lead ID": "LEGACY-1" }), regRow({}), regRow({ "Master Lead ID": "LEGACY-2" }), regRow({}), regRow({}), regRow({ "Next action": "call" }), regRow({}), regRow({ "Sales Lead ID": "S9" })];
  const sheets = world(rows); const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  let appendCalled = false; const oa = sheets.appendValues; sheets.appendValues = (...a) => { appendCalled = true; return oa(...a); };
  const ig = lead(1, { source: "ins", meta_leadgen_id: "123456789012345" });
  await run(sheets, osReader([ig]), io);
  assert.equal(appendCalled, false);
  const lastExisting = 5 + rows.length; // header row 5 + 8 rows = row 13
  assert.equal(sheets.grids[REG][lastExisting][col("Master Lead ID")], masterLeadId(ig)); // landed on row lastExisting+1
  assert.equal(sheets.grids[REG][lastExisting][col("Intake channel")], "FB Form");
  // target row not empty (someone typed in it between planning and writing)
  const s2 = world(rows); const io2 = mk(); io2.writeState({ ...io2.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  const og = s2.getValues; let n = 0; s2.getValues = async (id, range) => { if (id === REG && /^'Lead Register'!A\d+:AS\d+$/.test(range) && !/A5:/.test(range)) { s2.grids[REG][lastExisting] = ["intruder"]; } n++; return og(id, range); };
  const r = await run(s2, osReader([lead(2)]), io2);
  assert.equal(r.summary.register.error, "register_target_not_empty"); assert.equal(s2.grids[REG][lastExisting][0], "intruder"); assert.equal(s2.writes.filter((x) => x.id === REG).length, 0);
});

test("caps: over the per-run append limit or --max-writes writes nothing to the register", async () => {
  const many = Array.from({ length: 31 }, (_, i) => lead(i % 10, { id: `1000${String(i).padStart(4, "0")}-aaaa-0000-0000-000000000000`, phone: `+9715099${String(i).padStart(5, "0")}`, created_at: "2026-11-20T11:00:00.000Z" }));
  const sheets = world(); const io = mk(); io.writeState({ ...io.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  const r = await run(sheets, osReader(many), io); assert.equal(r.summary.register.error, "register_cap_exceeded"); assert.equal(regWrites(sheets).length, 0); assert.equal(r.exitCode, 1);
  const s2 = world(); const io2 = mk(); io2.writeState({ ...io2.readState(), register_watermark: "2026-11-20T09:00:00.000Z" });
  await assert.rejects(run(s2, osReader([lead(1), lead(2)]), io2, { args: { maxWrites: 1 } }), (e) => e.code === "cap_exceeded"); assert.equal(regWrites(s2).length, 0);
});

test("dry run: counts only, no personal data, no writes, no watermark change", async () => {
  const sheets = world(); const io = mk(); const l = lead(1, { customer_name: "Zed Unique", phone: "+971509876543" });
  const r = await run(sheets, osReader([l]), io, { cfg: DEFAULTS, args: { dryRun: true, registerSince: "2026-11-20T09:00:00.000Z" } });
  assert.equal(r.summary.register.would_append, 1); const txt = JSON.stringify(r.summary);
  assert.ok(!/Zed|9876543|example\.invalid/.test(txt)); assert.equal(sheets.writes.length, 0); assert.equal(io.readState().register_watermark, null); assert.equal(l.register_append, null);
  const none = await run(world(), osReader([l]), mk(), { cfg: DEFAULTS, args: { dryRun: true } }); assert.equal(none.summary.register, undefined);
});
