// OS -> Google Sheets + NAS incremental push (S28). Pure helpers only: no network, no disk, no clock.
// The worker (scripts/os-drive-nas-sync.mjs) wires these to Supabase, the Sheets API and the NAS helper.
// Rules these functions enforce for the sheets the sales team types in:
//   - a write is a single named cell or a whole OS-owned row, never anything else (guardSheets);
//   - rows are never deleted, rows that do not match are reported, never created (planCtwaColumnX);
//   - a second run on unchanged data plans zero writes (plan functions only report differences);
//   - a run that plans more writes than the cap writes nothing (assertWithinCap).
import { META_IDS_HEADER } from "./meta-ids-export.mjs";
import { normalizeWhatsAppPhoneKey } from "./whatsapp-ctwa.mjs";

export const DEFAULTS = Object.freeze({
  metaSheetId: "1f3AuUBbp7Gw7ncFbcQ9K4olwFT_v1BeyO5OdoAA8Bdw",
  salesSheetId: "118T8lf6RUemAz9YQezJ-sez4DaOtv1P6sxInpucDH8g",
  salesTab: "Home-owners",
  phoneColumn: "P",
  phoneHeader: "phone",
  clidColumn: "X",
  clidHeader: "meta_wa_ctwa_clid",
  maxWrites: 200,
  maxRequests: 40,
  overlapSeconds: 120,
  pendingDays: 14,
});

export class SyncError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

// ---------- small text helpers ----------
const cell = (v) => (v === null || v === undefined ? "" : String(v));

export function columnLetter(index) { // 0 -> A
  let n = index + 1; let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function columnIndex(letters) { // A -> 0
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Quote a tab name for A1 notation: 'Home-owners'!X5 (apostrophes doubled). */
export const a1Tab = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

/** Last 4 digits only, for reports. Phone numbers never appear in logs, reports or NAS records. */
export function maskPhone(raw) {
  const d = cell(raw).replace(/\D/g, "");
  return d.length >= 4 ? `***${d.slice(-4)}` : "***";
}

// ---------- phone keys ----------
/**
 * Sheet phone cells look like "p:+971585677181", "+9715...", "050 123 4567" or several numbers in one cell
 * separated by / , ; or a newline. Returns every valid key found (usually one).
 */
export function phoneKeysFromCell(raw) {
  const text = cell(raw).trim();
  if (!text) return [];
  const keys = [];
  for (const part of text.split(/[\/,;\n]+/)) {
    const key = normalizeWhatsAppPhoneKey(part.replace(/^\s*p\s*:/i, ""));
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}
export const phoneKey = (raw) => phoneKeysFromCell(raw)[0] ?? null;

// ---------- backoff ----------
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
export const isRetryableStatus = (status) => RETRYABLE_STATUS.has(status);

/** Equal-jitter exponential backoff: half fixed, half random. attempt starts at 0. */
export function backoffDelayMs(attempt, { baseMs = 500, capMs = 30_000, rand = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + rand() * (ceiling / 2));
}
/** Retry-After header (seconds or HTTP date) in ms, or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// ---------- write guard ----------
/**
 * Wrap a sheets client so that only the named writes can happen. policy[spreadsheetId] = {
 *   tab: allowed tab name (null = any), cells: RegExp for the A1 part of every written range, minRow, append: bool }.
 * A spreadsheet that is not in the policy cannot be written at all. Reads pass through untouched.
 */
export function guardSheets(sheets, policy) {
  const check = (id, range, kind) => {
    const rule = policy[id];
    if (!rule) throw new SyncError("write_blocked", `write to spreadsheet ${id.slice(0, 6)}... is not allowed`);
    if (kind === "append" && !rule.append) throw new SyncError("write_blocked", "append is not allowed on this spreadsheet");
    const bang = range.lastIndexOf("!");
    const tab = bang < 0 ? null : range.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
    const a1 = bang < 0 ? range : range.slice(bang + 1);
    if (rule.tab && tab !== rule.tab) throw new SyncError("write_blocked", `write outside tab ${rule.tab}`);
    if (!rule.cells.test(a1)) throw new SyncError("write_blocked", `write range ${a1} is outside the allowed cells`);
    const rows = [...a1.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
    if (kind !== "append" && (!rows.length || rows.some((r) => r < (rule.minRow ?? 2)))) throw new SyncError("write_blocked", "write touches the header row or has no row");
  };
  return {
    ...sheets,
    getValues: (...a) => sheets.getValues(...a),
    batchGetValues: (...a) => sheets.batchGetValues(...a),
    getFirstSheetTitle: (...a) => sheets.getFirstSheetTitle(...a),
    batchUpdateValues(id, data) { for (const d of data) check(id, d.range, "update"); return sheets.batchUpdateValues(id, data); },
    appendValues(id, range, values) { check(id, range, "append"); return sheets.appendValues(id, range, values); },
  };
}

export function buildWritePolicy({ metaSheetId, metaTab, salesSheetId, salesTab, clidColumn }) {
  const width = columnLetter(META_IDS_HEADER.length - 1);
  return {
    [metaSheetId]: { tab: metaTab, cells: new RegExp(`^A\\d+(:${width}\\d+)?$|^A(:${width})?$`), minRow: 2, append: true },
    // Sales sheet: exactly one cell of exactly one column, no appends, no header row.
    [salesSheetId]: { tab: salesTab, cells: new RegExp(`^${clidColumn}\\d+$`), minRow: 2, append: false },
  };
}

// ---------- Meta IDs sheet: keyed upsert ----------
export const metaRowKey = (r) => `${cell(r.lead_ref)}|${cell(r.meta_id_type)}|${cell(r.meta_id)}`;
export const metaValues = (row) => META_IDS_HEADER.map((k) => cell(row[k]));

export function checkMetaHeader(sheetValues) {
  const head = (sheetValues?.[0] ?? []).map((v) => cell(v).trim());
  const ok = META_IDS_HEADER.every((name, i) => head[i] === name);
  if (!ok) throw new SyncError("meta_header_mismatch", "Meta IDs sheet header row does not match META_IDS_HEADER; refusing to write");
}

/**
 * sheetValues: the A:O grid read from the sheet (row 1 = header). osRows: objects from buildMetaIdRows.
 * Returns {updates:[{row, values, previous}], appends:[values], unchanged, duplicateSheetKeys, firstEmptyRow}.
 * Nothing in the result deletes or blanks a sheet row.
 */
export function planMetaIdsUpsert(sheetValues, osRows) {
  checkMetaHeader(sheetValues);
  const index = new Map(); let duplicateSheetKeys = 0;
  for (let i = 1; i < sheetValues.length; i++) {
    const r = sheetValues[i] ?? [];
    if (!cell(r[0]) && !cell(r[2]) && !cell(r[3])) continue;
    const key = `${cell(r[0])}|${cell(r[2])}|${cell(r[3])}`; // lead_ref | meta_id_type | meta_id
    if (index.has(key)) { duplicateSheetKeys++; continue; }
    index.set(key, i);
  }
  const wanted = new Map();
  for (const row of osRows) wanted.set(metaRowKey(row), row);
  const updates = []; const appends = []; let unchanged = 0;
  for (const [key, row] of wanted) {
    const values = metaValues(row);
    const at = index.get(key);
    if (at === undefined) { appends.push(values); continue; }
    const current = META_IDS_HEADER.map((_, c) => cell(sheetValues[at]?.[c]));
    if (current.some((v, c) => v !== values[c])) updates.push({ row: at + 1, values, previous: current });
    else unchanged++;
  }
  return { updates, appends, unchanged, duplicateSheetKeys };
}

// ---------- Sales sheet: column X only ----------
/**
 * phoneCol / clidCol: arrays from reading the whole P and X columns (index 0 = row 1). Finds the header row in
 * the first 10 rows and refuses to continue unless P is 'phone' and X is 'meta_wa_ctwa_clid' on the same row.
 */
export function locateSalesColumns(phoneCol, clidCol, cfg = DEFAULTS) {
  for (let r = 0; r < Math.min(10, Math.max(phoneCol.length, clidCol.length)); r++) {
    if (cell(phoneCol[r]).trim().toLowerCase() === cfg.phoneHeader && cell(clidCol[r]).trim() === cfg.clidHeader) return r;
  }
  throw new SyncError("sales_header_mismatch", `Home-owners columns ${cfg.phoneColumn}/${cfg.clidColumn} do not carry headers ${cfg.phoneHeader}/${cfg.clidHeader}; refusing to write`);
}

/**
 * leads: [{lead_ref, phone, ctwa_clid, created_at}] (OS side). Returns
 * {writes:[{row, value, lead_ref}], unchanged, unmatched:[{lead_ref, reason}], ambiguous:[{lead_ref, rows}], manual:[{lead_ref, row}], conflicts}.
 * A cell is written only when it is empty or still holds the value this program wrote earlier for that lead (owned[lead_ref]);
 * anything else was typed by a person: skipped and reported, never overwritten.
 * Only ever plans a cell in the clid column of a data row; rows that do not match are reported, never created.
 */
export function planCtwaColumnX(phoneCol, clidCol, leads, cfg = DEFAULTS, owned = {}) {
  const headerRow = locateSalesColumns(phoneCol, clidCol, cfg);
  const byKey = new Map();
  for (let r = headerRow + 1; r < phoneCol.length; r++) {
    for (const key of phoneKeysFromCell(phoneCol[r])) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(r);
    }
  }
  // one id per phone: the earliest lead's click id (the first click is the one OS keeps)
  const perPhone = new Map(); const unmatched = []; let conflicts = 0;
  for (const lead of leads) {
    if (!cell(lead.ctwa_clid)) continue;
    const key = phoneKey(lead.phone);
    if (!key) { unmatched.push({ lead_ref: lead.lead_ref, reason: "no_phone" }); continue; }
    const seen = perPhone.get(key);
    if (!seen) { perPhone.set(key, lead); continue; }
    if (seen.ctwa_clid !== lead.ctwa_clid) conflicts++;
    if (Date.parse(lead.created_at ?? "") < Date.parse(seen.created_at ?? "")) perPhone.set(key, lead);
  }
  const writes = []; const ambiguous = []; let unchanged = 0; const manual = [];
  for (const [key, lead] of perPhone) {
    const rows = [...(byKey.get(key) ?? [])];
    if (rows.length === 0) { unmatched.push({ lead_ref: lead.lead_ref, reason: "no_row" }); continue; }
    if (rows.length > 1) { ambiguous.push({ lead_ref: lead.lead_ref, rows: rows.length }); continue; }
    const row = rows[0]; const current = cell(clidCol[row]).trim();
    if (current === lead.ctwa_clid) { unchanged++; continue; }
    if (current && current !== owned[lead.lead_ref]) { manual.push({ lead_ref: lead.lead_ref, row: row + 1 }); continue; }
    writes.push({ row: row + 1, value: lead.ctwa_clid, lead_ref: lead.lead_ref });
  }
  writes.sort((a, b) => a.row - b.row);
  return { writes, unchanged, unmatched, ambiguous, manual, conflicts };
}

// ---------- caps and verification ----------
export function assertWithinCap(planned, max) {
  if (!Number.isInteger(max) || max < 0) throw new SyncError("bad_cap", "max-writes must be a non-negative integer");
  if (planned > max) throw new SyncError("cap_exceeded", `planned ${planned} writes, above the cap of ${max}; nothing was written`);
}

/** expected/actual: arrays of {range, values}. Returns the ranges whose content differs (trailing blanks ignored). */
export function diffReadBack(expected, actual) {
  const trim = (rows) => (rows ?? []).map((r) => { const c = r.map(cell); while (c.length && c[c.length - 1] === "") c.pop(); return c; });
  const bad = [];
  for (let i = 0; i < expected.length; i++) {
    const want = trim(expected[i].values); const got = trim(actual[i]?.values ?? actual[i]);
    if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(expected[i].range);
  }
  return bad;
}

// ---------- state ----------
export function emptyState() {
  return { version: 1, leads_cursor: null, events_cursor: null, pending_ctwa: {}, last_ok_at: null, last_run_at: null,
    consecutive_failures: 0, nas_uploaded: {}, x_written: {} };
}
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  return { ...base, ...raw, pending_ctwa: raw.pending_ctwa && typeof raw.pending_ctwa === "object" ? raw.pending_ctwa : {},
    nas_uploaded: raw.nas_uploaded && typeof raw.nas_uploaded === "object" ? raw.nas_uploaded : {},
    x_written: raw.x_written && typeof raw.x_written === "object" ? raw.x_written : {} };
}
/** Query lower bound: cursor minus the overlap, so a late-committing row is never skipped. Null = full read. */
export function sinceFromCursor(cursor, overlapSeconds = DEFAULTS.overlapSeconds) {
  const ms = Date.parse(cursor ?? "");
  return Number.isFinite(ms) ? new Date(ms - overlapSeconds * 1000).toISOString() : null;
}
export const maxIso = (...values) => {
  let best = null;
  for (const v of values) { const ms = Date.parse(v ?? ""); if (Number.isFinite(ms) && (best === null || ms > best)) best = ms; }
  return best === null ? null : new Date(best).toISOString();
};
/** Alert on the 3rd consecutive failure and then every 36th (3 hours at 5 minutes), not on every failed run. */
export const shouldAlert = (n) => n === 3 || (n > 3 && n % 36 === 0);

export function dubaiDay(ms) { return new Date(ms + 4 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, ""); }

// ---------- CSV (for the nightly NAS file) ----------
export function parseCsv(text) {
  const rows = []; let row = []; let f = ""; let q = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// ---------- reconcile ----------
/** Compares OS rows with the sheet grid and (optionally) the latest nightly CSV rows. Counts and lead_refs only. */
export function reconcileMetaIds(osRows, sheetValues, nasRows) {
  const plan = planMetaIdsUpsert(sheetValues, osRows);
  const osKeys = new Set(osRows.map(metaRowKey));
  let sheetRows = 0; let extraInSheet = 0;
  for (let i = 1; i < sheetValues.length; i++) {
    const r = sheetValues[i] ?? [];
    if (!cell(r[0]) && !cell(r[2]) && !cell(r[3])) continue;
    sheetRows++;
    if (!osKeys.has(`${cell(r[0])}|${cell(r[2])}|${cell(r[3])}`)) extraInSheet++;
  }
  const out = { os_rows: osRows.length, sheet_rows: sheetRows, missing_in_sheet: plan.appends.length, outdated_in_sheet: plan.updates.length,
    extra_in_sheet: extraInSheet, duplicate_sheet_keys: plan.duplicateSheetKeys };
  if (nasRows) {
    const keys = new Set(); const header = nasRows[0] ?? [];
    const at = (n) => header.indexOf(n);
    for (let i = 1; i < nasRows.length; i++) keys.add(`${cell(nasRows[i][at("lead_ref")])}|${cell(nasRows[i][at("meta_id_type")])}|${cell(nasRows[i][at("meta_id")])}`);
    out.nas_rows = keys.size;
    out.nas_not_in_os = [...keys].filter((k) => !osKeys.has(k)).length;
    out.os_not_in_nas = [...osKeys].filter((k) => !keys.has(k)).length; // expected > 0 for rows created since the nightly file
  }
  out.drift = out.missing_in_sheet > 0 || out.outdated_in_sheet > 0 || out.duplicate_sheet_keys > 0 || (out.nas_not_in_os ?? 0) > 0;
  return out;
}

export function formatReport({ day, mode, meta, ctwa, health, notes = [] }) {
  const lines = [`NewMe OS -> Drive/NAS reconcile ${day} (${mode})`, ""];
  if (meta) {
    lines.push("Meta ID registry (OS vs sheet vs latest nightly file)");
    for (const [k, v] of Object.entries(meta)) lines.push(`  ${k}: ${v}`);
    lines.push("");
  }
  if (ctwa) {
    lines.push("Click-to-WhatsApp ids vs sales sheet column X (counts only)");
    for (const [k, v] of Object.entries(ctwa)) lines.push(`  ${k}: ${Array.isArray(v) ? v.length : v}`);
    lines.push("");
  }
  if (health) { lines.push("Worker health"); for (const [k, v] of Object.entries(health)) lines.push(`  ${k}: ${v}`); lines.push(""); }
  for (const n of notes) lines.push(n);
  return `${lines.join("\n").trimEnd()}\n`;
}
