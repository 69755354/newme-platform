// S28: OS -> Google Sheets + NAS push. Fake Sheets grid and fake OS reader; no network, no disk outside a temp dir.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { META_IDS_HEADER } from "../../src/lib/meta-ids-export.mjs";
import { SyncError } from "../../src/lib/os-drive-sync.mjs";
import { createSheetsClient } from "../../src/lib/google-sheets-client.mjs";
import {
  backoffDelayMs, buildWritePolicy, columnIndex, columnLetter, guardSheets, phoneKey, phoneKeysFromCell, planCtwaColumnX,
  planMetaIdsUpsert, retryAfterMs, BLUE, HEADER_NOTE, noteWritten, shouldAlert, sinceFromCursor, maskPhone, assertWithinCap, DEFAULTS,
} from "../../src/lib/os-drive-sync.mjs";
import { createIo, parseArgs, runReconcile, runSync } from "../../scripts/os-drive-nas-sync.mjs";

const META = DEFAULTS.metaSheetId; const SALES = DEFAULTS.salesSheetId;
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
const salesGrid = (rows) => [[...Array(15).fill("a"), "phone", ...Array(7).fill("b"), "meta_wa_ctwa_clid"].map((v, i) => (i === 15 ? "phone" : i === 23 ? "meta_wa_ctwa_clid" : v)), ...rows];
const sRow = (phone, x = "", other = "keep") => { const r = Array(24).fill(""); r[0] = other; r[1] = other; r[15] = phone; r[23] = x; return r; };
const metaGrid = (rows = []) => [[...META_IDS_HEADER], ...rows];
const lead = (n, extra = {}) => ({ id: `0000000${n}-0000-0000-0000-000000000000`, phone: `+97150000000${n}`, ctwa_clid: `CLID_${n}_abcdefghij`, meta_leadgen_id: null, campaign_id: "c1", campaign_name: "C", adset_id: "", ad_id: "ad", ad_name: "AD",
  created_at: "2026-11-19T10:00:00.000Z", updated_at: `2026-11-19T10:0${n}:00.000Z`, stage: "new", final_status: "", archived: false, ...extra });
function reader(leads, { events = [] } = {}) {
  return {
    async leadsChangedSince(since) { return leads.filter((l) => !since || l.updated_at > since); },
    async leadIdsWithEventsSince() { return events; },
    async leadsByIds(ids) { return leads.filter((l) => ids.includes(l.id)); },
    async eventsForLeads() { return { formEvents: [], whatsappEvents: [] }; },
  };
}
function setup(leads, grids) {
  const dir = mkdtempSync(join(tmpdir(), "s28-"));
  const io = createIo(dir, join(dir, "meta-ids"));
  const sheets = fakeSheets(grids);
  const uploads = []; const nas = { fail: false, upload: async (f) => { if (nas.fail) throw new SyncError("nas_upload_failed", "x"); uploads.push(f); } };
  const clock = { t: Date.parse("2026-11-20T08:00:00Z") };
  const args = { dryRun: false, maxWrites: 200 };
  const run = (extra = {}) => runSync({ osReader: reader(leads), sheets: extra.sheets ?? sheets, nas, io, args: { ...args, ...extra.args }, now: () => clock.t, log: () => {} });
  return { dir, io, sheets, uploads, run, clock, nas };
}

test("phone normalization handles sheet spellings", () => {
  assert.equal(phoneKey("p:+971585677181"), "971585677181");
  assert.equal(phoneKey("0585677181"), "971585677181");
  assert.equal(phoneKey("585677181"), "971585677181");
  assert.equal(phoneKey("00971 58 567 7181"), "971585677181");
  assert.deepEqual(phoneKeysFromCell("0501234567 / +971509999999"), ["971501234567", "971509999999"]);
  assert.equal(phoneKey("n/a"), null);
  assert.equal(maskPhone("+971585677181"), "***7181");
});

test("column helpers and backoff", () => {
  assert.equal(columnLetter(0), "A"); assert.equal(columnLetter(23), "X"); assert.equal(columnLetter(26), "AA");
  assert.equal(columnIndex("X"), 23);
  assert.ok(backoffDelayMs(0, { rand: () => 0 }) === 250 && backoffDelayMs(0, { rand: () => 1 }) === 500);
  assert.equal(backoffDelayMs(20, { rand: () => 1 }), 30_000);
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(sinceFromCursor("2026-11-19T10:00:00.000Z", 120), "2026-11-19T09:58:00.000Z");
  assert.equal(sinceFromCursor(null), null);
  assert.ok(shouldAlert(3) && !shouldAlert(4) && shouldAlert(36) && !shouldAlert(1));
  assert.throws(() => assertWithinCap(5, 4), /nothing was written/);
});

test("sheets client retries 429 and 503 with backoff and honours the request budget", async () => {
  const sa = { client_email: "x@y", token_uri: "https://t", private_key: (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) };
  const seq = [429, 503, 200, 200]; const sleeps = [];
  const fetchImpl = async (url) => {
    if (String(url) === "https://t") return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) };
    const status = seq.shift();
    return { ok: status === 200, status, headers: { get: () => null }, json: async () => ({ values: [["a"]] }) };
  };
  const c = createSheetsClient({ serviceAccount: sa, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, rand: () => 0.5, maxRequests: 10 });
  assert.deepEqual(await c.getValues("id", "A1"), [["a"]]);
  assert.equal(sleeps.length, 2); assert.ok(sleeps[1] > sleeps[0]);
  const tight = createSheetsClient({ serviceAccount: sa, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: "t", values: [] }) }), maxRequests: 2 });
  await tight.getValues("i", "A1");
  await assert.rejects(() => tight.getValues("i", "A1"), /budget/);
});

test("guard: sales sheet accepts only single X cells below the header; no appends; unknown sheet blocked", async () => {
  const sheets = fakeSheets({ [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  const g = guardSheets(sheets, buildWritePolicy({ ...DEFAULTS, metaTab: "Registry" }));
  await g.batchUpdateValues(SALES, [{ range: "'Home-owners'!X2", values: [["z"]] }]);
  for (const bad of ["'Home-owners'!W2", "'Home-owners'!X1", "'Home-owners'!A2", "'Home-owners'!X2:X3", "'Other'!X2", "'Home-owners'!P:P", "'Home-owners'!X:X", "'Home-owners'!A2:O2"]) {
    await assert.rejects(async () => g.batchUpdateValues(SALES, [{ range: bad, values: [["z"]] }]), /not allowed|outside|header/, bad);
  }
  await assert.rejects(async () => g.appendValues(SALES, "'Home-owners'!A1", [["x"]]), /append/);
  await assert.rejects(async () => g.batchUpdateValues("another-sheet", [{ range: "A2", values: [["x"]] }]), /not allowed/);
  await assert.rejects(async () => g.batchUpdateValues(META, [{ range: "'Registry'!A1:O1", values: [[]] }]), /header/);
  await g.batchUpdateValues(META, [{ range: "'Registry'!A2:O2", values: [["x"]] }]);
});

test("planMetaIdsUpsert: update in place, append new, never delete; header mismatch refuses", () => {
  const row = { lead_ref: "aaa", source: "whatsapp", meta_id_type: "ctwa_clid", meta_id: "ID1", stage: "new", archived: "false" };
  const existing = META_IDS_HEADER.map((k) => row[k] ?? "");
  const stale = [...existing]; stale[10] = "old";
  const orphan = META_IDS_HEADER.map((k) => ({ lead_ref: "zzz", meta_id_type: "leadgen", meta_id: "Q" }[k] ?? ""));
  const p = planMetaIdsUpsert([[...META_IDS_HEADER], stale, orphan], [row, { ...row, lead_ref: "bbb", meta_id: "ID2" }]);
  assert.equal(p.updates.length, 1); assert.equal(p.updates[0].row, 2); assert.equal(p.appends.length, 1);
  assert.equal(JSON.stringify(p).includes("zzz"), false, "rows only in the sheet are left alone");
  assert.throws(() => planMetaIdsUpsert([["wrong"]], [row]), /header/);
});

test("planCtwaColumnX: matches by phone, reports unmatched and ambiguous, never writes non-data rows", () => {
  const g = salesGrid([sRow("p:+971500000001"), sRow("0500000002", "OLD"), sRow("+971500000003"), sRow("+971500000003"), sRow("+971500000004", "CLID_4_abcdefghij")]);
  const P = g.map((r) => r[15]); const X = g.map((r) => r[23]);
  const leads = [1, 2, 3, 4, 5].map((n) => ({ lead_ref: `r${n}`, phone: `+97150000000${n}`, ctwa_clid: `CLID_${n}_abcdefghij`, created_at: "2026-11-19" }));
  const p = planCtwaColumnX(P, X, leads);
  assert.deepEqual(p.writes.map((w) => [w.row, w.lead_ref]), [[2, "r1"]]);
  assert.deepEqual(p.manual, [{ lead_ref: "r2", row: 3, edited: false, current: "OLD" }], "a value typed by a person is skipped, never overwritten");
  assert.equal(p.unchanged, 1);
  const owned = planCtwaColumnX(P, X, leads, DEFAULTS, { r2: "OLD" });
  assert.deepEqual(owned.writes.map((w) => w.lead_ref), ["r1", "r2"], "a value this program wrote earlier may be updated");
  assert.equal(owned.manual.length, 0);
  assert.deepEqual(p.ambiguous.map((a) => a.lead_ref), ["r3"]);
  assert.deepEqual(p.unmatched, [{ lead_ref: "r5", reason: "no_row" }]);
  assert.throws(() => planCtwaColumnX(["x", "+971500000001"], ["y", ""], leads), /refusing/);
});

test("run: writes Meta IDs rows and column X only, nothing else changes, reads back, spools to NAS", async () => {
  const sales = salesGrid([sRow("p:+971500000001", "", "typed-by-sales"), sRow("+971500000009", "", "other-person")]);
  const before = JSON.stringify(sales);
  const t = setup([lead(1), lead(2)], { [META]: metaGrid(), [SALES]: sales });
  const r = await t.run();
  assert.equal(r.exitCode, 0); assert.equal(r.summary.meta_appends, 2); assert.equal(r.summary.x_writes, 1); assert.equal(r.summary.x_unmatched, 1);
  assert.equal(t.sheets.grids[META].length, 3);
  const diffCells = []; const b = JSON.parse(before);
  sales.forEach((row, i) => row.forEach((v, j) => { if ((b[i]?.[j] ?? "") !== v) diffCells.push(`${columnLetter(j)}${i + 1}`); }));
  assert.deepEqual(diffCells, ["X2"], "only column X of the matched row changed");
  assert.equal(sales[1][0], "typed-by-sales");
  for (const w of t.sheets.writes.filter((x) => x.id === SALES)) assert.match(w.range, /^'Home-owners'!X\d+$/);
  assert.deepEqual(t.sheets.fmt[`${SALES}:2,23`].bg, BLUE);
  assert.equal(t.sheets.fmt[`${SALES}:2,23`].note, noteWritten(t.clock.t, "NM-000000010000"));
  assert.ok(!t.sheets.fmt[`${SALES}:2,23`].note.includes("9715"), "note carries no phone");
  assert.equal(t.uploads.length, 1);
  const jsonl = readFileSync(t.io.changesFile("20261120").file, "utf8");
  assert.ok(!jsonl.includes("+9715") && !jsonl.includes("0500000"), "no phone numbers in the NAS records");
  assert.equal(jsonl.trim().split("\n").length, 4, "2 appends + 1 X write + the one-time header note");
});

test("run: a human-typed X value is left alone and reported; our own earlier value is updated", async () => {
  const sales = salesGrid([sRow("+971500000001", "typed-by-hand"), sRow("+971500000002")]);
  const leads = [lead(1), lead(2)];
  const t = setup(leads, { [META]: metaGrid(), [SALES]: sales });
  const r = await t.run();
  assert.equal(r.summary.x_manual_skipped, 1); assert.equal(r.summary.x_writes, 1);
  assert.equal(sales[1][23], "typed-by-hand"); assert.equal(sales[2][23], "CLID_2_abcdefghij");
  assert.ok(!readFileSync(t.io.changesFile("20261120").file, "utf8").includes("typed-by-hand"), "no old values in NAS records");
  leads[1].ctwa_clid = "CLID_2_changedvalue"; leads[1].updated_at = "2026-11-20T07:00:00.000Z";
  const r2 = await t.run();
  assert.equal(r2.summary.x_writes, 1); assert.equal(sales[2][23], "CLID_2_changedvalue");
  assert.equal(sales[1][23], "typed-by-hand");
});

test("meta sheet: header note once, new and updated rows blue, updated cells carry a note with the last time", async () => {
  const leads = [lead(1, { updated_at: "2026-11-18T00:00:00.000Z" })];
  const t = setup(leads, { [META]: metaGrid(), [SALES]: salesGrid([]) });
  await t.run();
  const f = t.sheets.fmt;
  assert.equal(f[`${META}:1,0`].note, HEADER_NOTE);
  assert.deepEqual(f[`${META}:2,0`].bg, BLUE); assert.deepEqual(f[`${META}:2,14`].bg, BLUE);
  leads[0].stage = "qualified"; leads[0].updated_at = "2026-11-20T07:00:00.000Z"; t.clock.t += 3_600_000;
  await t.run();
  assert.match(f[`${META}:2,10`].note, /^OS 更新 迪拜时间 2026-11-20 13:00｜上次 2026-11-20 12:00$/);
  assert.equal(f[`${META}:2,3`].note, undefined, "unchanged cells get no new note");
  assert.equal(t.sheets.writes.filter((w) => w.format && w.range === "'Registry'!A1").length, 1, "header note written only once");
});

test("a person edits a value the program wrote: left alone, no format write, logged once", async () => {
  const sales = salesGrid([sRow("+971500000001")]);
  const leads = [lead(1)];
  const t = setup(leads, { [META]: metaGrid(), [SALES]: sales });
  await t.run();
  sales[1][23] = "hand-edited";
  leads[0].updated_at = "2026-11-20T06:00:00.000Z";
  const before = t.sheets.writes.filter((w) => w.id === SALES).length;
  const r = await t.run();
  assert.equal(r.summary.x_manual_skipped, 1); assert.equal(sales[1][23], "hand-edited");
  assert.equal(t.sheets.writes.filter((w) => w.id === SALES).length, before, "nothing written to the sales sheet");
  assert.deepEqual(t.sheets.fmt[`${SALES}:2,23`].bg, BLUE, "colour is still the one OS set earlier");
  leads[0].updated_at = "2026-11-20T06:30:00.000Z";
  await t.run();
  const log = readFileSync(t.io.changesFile("20261120").file, "utf8");
  assert.equal(log.split("skipped_manual_value").length - 1, 1, "logged once per distinct value");
  assert.ok(!log.includes("hand-edited"), "the person's text is not copied anywhere");
});

test("guard: format requests only reach already-allowed cells; anything else is refused", async () => {
  const sheets = fakeSheets({ [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  const g = guardSheets(sheets, buildWritePolicy({ ...DEFAULTS, metaTab: "Registry" }));
  await g.batchUpdateCells(SALES, "Home-owners", [{ kind: "cell", row: 2, col: 23, value: "x", bg: BLUE, note: "n" }]);
  const refuse = (id, tab, op) => assert.rejects(async () => g.batchUpdateCells(id, tab, [op]), /not allowed|outside|header|unknown|unexpected/);
  await refuse(SALES, "Home-owners", { kind: "cell", row: 2, col: 22, bg: BLUE });          // column W
  await refuse(SALES, "Home-owners", { kind: "cell", row: 1, col: 23, bg: BLUE });          // header row
  await refuse(SALES, "Home-owners", { kind: "rowbg", row: 2, c1: 0, c2: 23, bg: BLUE });   // whole row
  await refuse(SALES, "Home-owners", { kind: "headernote", row: 1, col: 0, note: "x" });      // header note only on the OS sheet
  await refuse(SALES, "Other tab", { kind: "cell", row: 2, col: 23, bg: BLUE });
  await refuse(SALES, "Home-owners", { kind: "deleteRow", row: 2 });
  await refuse(SALES, "Home-owners", { kind: "cell", row: 2, col: 23, bg: BLUE, textFormat: { bold: true } });
  await refuse("another", "Home-owners", { kind: "cell", row: 2, col: 23, bg: BLUE });
  await g.batchUpdateCells(META, "Registry", [{ kind: "headernote", row: 1, col: 0, note: HEADER_NOTE }, { kind: "rowbg", row: 2, c1: 0, c2: 14, bg: BLUE }]);
  await refuse(META, "Registry", { kind: "headernote", row: 1, col: 3, note: "x" });
  await refuse(META, "Registry", { kind: "cell", row: 2, col: 15, bg: BLUE });                // column P
});

test("read-back compares colour and note, not only the value", async () => {
  const t = setup([lead(1)], { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  const noColour = { ...t.sheets, batchUpdateCells: async (id, tab, ops) => t.sheets.batchUpdateCells(id, tab, ops.map((o) => (id === SALES ? { ...o, bg: undefined } : o))) };
  Object.defineProperty(noColour, "requestCount", { get: () => 0 });
  await assert.rejects(() => t.run({ sheets: noColour }), (e) => e.code === "readback_mismatch");
});

test("run is idempotent: a second run (and a --full re-run) plans and writes nothing", async () => {
  const t = setup([lead(1), lead(2)], { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  await t.run(); const writesAfterFirst = t.sheets.writes.length;
  const second = await t.run();
  assert.equal(second.summary.planned_writes, 0); assert.equal(t.sheets.writes.length, writesAfterFirst);
  const third = await t.run({ args: { full: true } });
  assert.equal(third.summary.planned_writes, 0); assert.equal(t.sheets.writes.length, writesAfterFirst);
  assert.equal(t.uploads.length, 1, "unchanged spool is not uploaded again");
});

test("incremental run only reads leads changed since the cursor and updates changed rows in place", async () => {
  const leads = [lead(1, { updated_at: "2026-11-18T00:00:00.000Z" }), lead(2)];
  const t = setup(leads, { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  await t.run();
  leads[1].stage = "qualified"; leads[1].updated_at = "2026-11-20T07:00:00.000Z";
  const r = await t.run();
  assert.equal(r.summary.leads_examined, 1); assert.equal(r.summary.meta_updates, 1); assert.equal(r.summary.meta_appends, 0);
  assert.equal(t.sheets.grids[META].length, 3);
  assert.equal(t.sheets.grids[META][2][10], "qualified");
});

test("cap: more planned writes than --max-writes writes nothing and keeps the cursor", async () => {
  const leads = [1, 2, 3].map((n) => lead(n));
  const t = setup(leads, { [META]: metaGrid(), [SALES]: salesGrid([]) });
  await assert.rejects(() => t.run({ args: { maxWrites: 2 } }), (e) => e.code === "cap_exceeded");
  assert.equal(t.sheets.writes.length, 0); assert.equal(t.io.readState().leads_cursor, null);
});

test("dry-run writes nothing, saves no state", async () => {
  const t = setup([lead(1)], { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  const r = await t.run({ args: { dryRun: true } });
  assert.equal(r.summary.planned_writes, 2); assert.equal(t.sheets.writes.length, 0); assert.equal(t.io.readState().last_ok_at, null);
});

test("read-back mismatch: retried once, then fails loudly", async () => {
  const t = setup([lead(1)], { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  const bad = { ...t.sheets, batchUpdateCells: async (id, tab, ops) => { if (id !== SALES) return t.sheets.batchUpdateCells(id, tab, ops); t.sheets.writes.push({ id, range: "dropped" }); return {}; } }; // silently drops writes
  Object.defineProperty(bad, "requestCount", { get: () => 0 });
  await assert.rejects(() => t.run({ sheets: bad }), (e) => e.code === "readback_mismatch");
  assert.equal(t.io.readState().leads_cursor, null, "cursor not advanced after a failed write");
  assert.equal(t.sheets.writes.filter((w) => w.id === SALES && w.range === "dropped").length, 2, "one write plus one retry");
});

test("unmatched click ids stay pending and are retried when the sheet row appears", async () => {
  const sales = salesGrid([]);
  const t = setup([lead(1)], { [META]: metaGrid(), [SALES]: sales });
  await t.run();
  assert.equal(Object.keys(t.io.readState().pending_ctwa).length, 1);
  sales.push(sRow("+971500000001"));
  const r = await t.run();
  assert.equal(r.summary.x_writes, 1); assert.equal(sales[1][23], "CLID_1_abcdefghij");
  assert.equal(Object.keys(t.io.readState().pending_ctwa).length, 0);
});

test("reconcile reports drift with counts only and exits non-zero", async () => {
  const leads = [lead(1), lead(2)];
  const t = setup(leads, { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  const opts = { osReader: reader(leads), sheets: t.sheets, io: t.io, now: () => t.clock.t };
  assert.equal((await runReconcile(opts)).exitCode, 1, "empty sheet = drift");
  await t.run();
  const ok = await runReconcile(opts);
  assert.equal(ok.exitCode, 0);
  const text = readFileSync(ok.summary.report, "utf8");
  assert.match(text, /missing_in_sheet: 0/); assert.ok(!text.includes("971500"));
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--max-writes", "5"]).maxWrites, 5);
  assert.throws(() => parseArgs(["--bogus"]));
  assert.throws(() => parseArgs(["--max-writes", "x"]));
});

test("NAS: a day whose upload failed is re-uploaded after midnight, not only the current day's file", async () => {
  const leads = [lead(1, { updated_at: "2026-11-18T00:00:00.000Z" })];
  const t = setup(leads, { [META]: metaGrid(), [SALES]: salesGrid([]) });
  t.nas.fail = true;
  const first = await t.run();
  assert.equal(first.exitCode, 1); assert.equal(t.uploads.length, 0);
  t.nas.fail = false; t.clock.t += 13 * 3_600_000; // 01:00 Dubai the next day
  leads[0].stage = "qualified"; leads[0].updated_at = "2026-11-20T21:00:00.000Z";
  await t.run();
  assert.deepEqual(t.uploads.map((f) => f.split("/").pop()).sort(), ["20261120.jsonl", "20261121.jsonl"]);
});

test("audit: what the Meta sheet got is in the spool even when a later step throws", async () => {
  const t = setup([lead(1)], { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  const failing = { ...t.sheets, getCells: async (id, r) => { if (id === SALES) throw new SyncError("http_500", "boom"); return t.sheets.getCells(id, r); } };
  Object.defineProperty(failing, "requestCount", { get: () => 0 });
  await assert.rejects(() => t.run({ sheets: failing }), (e) => e.code === "http_500");
  const log = readFileSync(t.io.changesFile("20261120").file, "utf8");
  assert.match(log, /"sheet":"meta_ids","action":"append"/);
  assert.match(log, /"sheet":"home_owners_x","action":"write"/, "the X write that landed before the failed read-back is logged too");
  assert.equal(t.io.readState().x_written["NM-000000010000"], "CLID_1_abcdefghij");
  assert.equal(t.io.readState().leads_cursor, null);
});

test("two numbers in one phone cell that belong to different leads: no write, reported as ambiguous destination", () => {
  const g = salesGrid([sRow("0500000001 / +971500000002"), sRow("+971500000003")]);
  const P = g.map((r) => r[15]); const X = g.map((r) => r[23]);
  const leads = [1, 2, 3].map((n) => ({ lead_ref: `r${n}`, phone: `+97150000000${n}`, ctwa_clid: `CLID_${n}_abcdefghij`, created_at: "2026-11-19" }));
  const p = planCtwaColumnX(P, X, leads);
  assert.deepEqual(p.writes.map((w) => w.lead_ref), ["r3"]);
  assert.deepEqual(p.ambiguousDestination.map((a) => [a.lead_ref, a.row]).sort(), [["r1", 2], ["r2", 2]]);
  const same = planCtwaColumnX(P, X, [leads[0], { ...leads[1], ctwa_clid: leads[0].ctwa_clid }], DEFAULTS);
  assert.equal(same.writes.length, 1, "two leads with the same id write once");
});

test("append lost or landed on a network error: never duplicated, always present once", async () => {
  for (const mode of ["lost", "landed"]) {
    const t = setup([lead(1), lead(2)], { [META]: metaGrid(), [SALES]: salesGrid([]) });
    t.sheets.inject.append = mode;
    const r = await t.run();
    assert.equal(r.exitCode, 0, mode);
    const keys = t.sheets.grids[META].slice(1).map((row) => row[3]);
    assert.deepEqual(keys.sort(), ["CLID_1_abcdefghij", "CLID_2_abcdefghij"], mode);
    assert.equal(t.sheets.grids[META].length, 3, `${mode}: header + 2 rows, no duplicates`);
    assert.deepEqual(t.sheets.fmt[`${META}:2,0`].bg, BLUE, `${mode}: marked after recovery`);
    const again = await t.run();
    assert.equal(again.summary.planned_writes, 0);
  }
});

test("sheets client never repeats an append after a network error or 5xx, but does after 429", async () => {
  const sa = { client_email: "x@y", token_uri: "https://t", private_key: (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) };
  for (const [first, expectedCalls] of [["net", 1], [503, 1], [429, 2]]) {
    let appendCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url) === "https://t") return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) };
      appendCalls++;
      if (appendCalls === 1 && first === "net") throw new Error("socket");
      if (appendCalls === 1) return { ok: false, status: first, headers: { get: () => null } };
      return { ok: true, status: 200, json: async () => ({ updates: {} }) };
    };
    const c = createSheetsClient({ serviceAccount: sa, fetchImpl, sleep: async () => {}, rand: () => 0 });
    await c.appendValues("id", "A1", [["x"]]).catch(() => {});
    assert.equal(appendCalls, expectedCalls, String(first));
  }
});

test("S30: a retried unmatched click id keeps its first pending time and expires after pendingDays", async () => {
  const t = setup([lead(1)], { [META]: metaGrid(), [SALES]: salesGrid([]) });
  await t.run();
  const first = t.io.readState().pending_ctwa["00000001-0000-0000-0000-000000000000"];
  assert.ok(first);
  t.clock.t += 3_600_000; await t.run();
  assert.equal(t.io.readState().pending_ctwa["00000001-0000-0000-0000-000000000000"], first, "retry does not reset the start time");
  t.clock.t += DEFAULTS.pendingDays * 86_400_000; await t.run();
  assert.equal(Object.keys(t.io.readState().pending_ctwa).length, 0, "dropped after the expiry");
});

test("S30: a failed provenance format write is saved and finished on the next run", async () => {
  const t = setup([lead(1)], { [META]: metaGrid(), [SALES]: salesGrid([]) });
  const failing = { ...t.sheets, batchUpdateCells: async (id) => { if (id === META) throw new SyncError("http_500", "boom"); return {}; } };
  Object.defineProperty(failing, "requestCount", { get: () => 0 });
  await assert.rejects(() => t.run({ sheets: failing }), (e) => e.code === "http_500");
  assert.equal(t.sheets.grids[META].length, 2, "the row values landed");
  const pending = t.io.readState().pending_meta_format;
  assert.equal(Object.keys(pending).length, 1, "the unfinished blue + note is in the state");
  const r = await t.run();
  assert.equal(r.summary.meta_appends + r.summary.meta_updates, 0, "values are already there");
  assert.equal(t.sheets.fmt[`${META}:2,0`]?.bg?.blue, 1, "the row is blue now");
  assert.match(t.sheets.fmt[`${META}:2,0`]?.note ?? "", /OS 更新/);
  assert.deepEqual(t.io.readState().pending_meta_format, {}, "cleared after success");
});

test("S30: a NAS upload failure counts in worker health and reconcile reports the unconfirmed spool as drift", async () => {
  const leads = [lead(1)];
  const t = setup(leads, { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001")]) });
  t.nas.fail = true;
  const r = await t.run();
  assert.equal(r.exitCode, 1);
  const st = t.io.readState();
  assert.equal(st.consecutive_failures, 1); assert.equal(st.last_ok_at, null, "last_ok_at not advanced");
  const rec = await runReconcile({ osReader: reader(leads), sheets: t.sheets, io: t.io, now: () => t.clock.t });
  assert.equal(rec.exitCode, 1); assert.equal(rec.summary.drift, true);
  assert.match(readFileSync(rec.summary.report, "utf8"), /nas_unconfirmed_spool_days: 1/);
  t.nas.fail = false; t.clock.t += 300_000; await t.run();
  assert.equal(t.io.readState().consecutive_failures, 0); assert.ok(t.io.readState().last_ok_at);
  const ok = await runReconcile({ osReader: reader(leads), sheets: t.sheets, io: t.io, now: () => t.clock.t });
  assert.match(readFileSync(ok.summary.report, "utf8"), /nas_unconfirmed_spool_days: 0/);
  assert.equal(ok.exitCode, 0);
});

test("S45: unmatched / unwritten click ids are warnings (exit 0, listed in the report); real drift still exits 1", async () => {
  const leads = [lead(1), lead(2), lead(3)];
  // lead 1 has a sheet row, lead 2 has none (unmatched), lead 3 has a row whose column X the worker has not filled yet
  const t = setup(leads, { [META]: metaGrid(), [SALES]: salesGrid([sRow("+971500000001"), sRow("+971500000003")]) });
  await t.run();
  t.sheets.grids[SALES][2][23] = ""; // the write for lead 3 is outstanding when the nightly runs
  const opts = { osReader: reader(leads), sheets: t.sheets, io: t.io, now: () => t.clock.t };
  const warn = console.warn; const logged = []; console.warn = (m) => logged.push(m);
  let r; try { r = await runReconcile(opts); } finally { console.warn = warn; }
  assert.equal(r.exitCode, 0); assert.equal(r.summary.drift, false); assert.ok(r.summary.warnings >= 1);
  assert.ok(logged.some((m) => /WARNING/.test(m)));
  const text = readFileSync(r.summary.report, "utf8");
  assert.match(text, /WARNING: some click ids are not matched into column X \(unmatched=1/); assert.match(text, /ok \(with warnings\)/);
  assert.ok(!text.includes("971500"));
  // a real data-loss condition (the sheet lost a Meta registry row) still fails
  t.sheets.grids[META].length = 1;
  const bad = await runReconcile(opts);
  assert.equal(bad.exitCode, 1); assert.equal(bad.summary.drift, true);
});
