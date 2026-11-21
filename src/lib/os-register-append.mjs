// OS -> sales "Lead Register": append-only intake rows for NEW OS leads (S28 extension, switch OS_DRIVE_REGISTER_APPEND_ENABLED, default off).
// Pure helpers only: no network, no disk, no clock. The worker (scripts/os-drive-nas-sync.mjs) wires them to Supabase and Sheets.
// Rules:
//   - header of the register is verified by name on every run; a different header means nothing is written;
//   - only leads created after the start watermark (set when the switch is first turned on) are looked at, never old ones;
//   - a lead is appended only when neither its Master Lead ID nor its phone / Meta lead id is already on the register;
//   - only the intake columns are written; every other column is left empty for the people who work the register;
//   - existing rows are never edited, moved or deleted.
import { fingerprintOf, norm } from "./drive-sync.mjs";
import { leadRef } from "./meta-ids-export.mjs";
import { BLUE, SyncError, dubaiStamp, maskRef, phoneKeysFromCell, phoneKey } from "./os-drive-sync.mjs";

export const REGISTER = Object.freeze({
  spreadsheetId: "1t8ZbfF8hmv51KcNfWuwLPPII1IGMc6AWJgfxlCAew7w", // same file as S29 SOURCES.lead_register
  tab: "Lead Register",
  headerRow: 5,
  lastColumn: "AS",
  maxAppendRows: 30,
});

/** Every header name the register carries today (S29 sources + one-off importer), in sheet order. Verified as an ordered subsequence. */
export const REGISTER_HEADER = Object.freeze([
  "Assigned to", "Client", "Primary phone", "Intake channel", "Requirement / Context", "Segment", "Received at", "Location", "Email", "Campaign", "Ad",
  "Review decision", "Review notes", "Duplicate of", "Dispatch status", "Routing note", "Assigned at", "Contact status", "Lead quality", "Quality reason",
  "Sales feedback", "First contact at", "Quality assessed at", "Next action date", "Next action", "Opportunity stage", "Quote value AED", "Last synced at",
  "Master Lead ID", "Source lead ID", "Campaign ID", "Adset ID", "Ad ID", "Source URL", "Original source comment", "Test record", "Sales Lead ID", "Routed owner",
]);
/** The only columns this program ever writes. */
export const WRITE_COLUMNS = Object.freeze(["Master Lead ID", "Received at", "Intake channel", "Client", "Primary phone", "Email", "Campaign", "Ad", "Source lead ID", "Campaign ID", "Adset ID", "Ad ID"]);
/** The id columns (AK..AN): same prefixes as the sheet importer reads back (l: / ctwa: / c: / as: / ag:). */
export const ID_COLUMNS = Object.freeze(["Source lead ID", "Campaign ID", "Adset ID", "Ad ID"]);

/**
 * rowValues: the grid read from the register starting at the header row (index 0 = header). Returns {index: {name: columnIndex}}.
 * Throws register_header_mismatch unless every name of REGISTER_HEADER appears exactly once and in the same relative order.
 */
export function checkRegisterHeader(rowValues) {
  const head = (rowValues?.[0] ?? []).map((v) => norm(v));
  const index = {}; let last = -1;
  for (const name of REGISTER_HEADER) {
    const hits = head.flatMap((h, i) => (h === name ? [i] : []));
    if (hits.length !== 1 || hits[0] <= last) throw new SyncError("register_header_mismatch", "Lead Register header row differs from the expected columns; refusing to write");
    index[name] = hits[0]; last = hits[0];
  }
  return { index, width: head.length };
}

// ---------- keys ----------
const LEADGEN = /^[1-9]\d{7,31}$/;
/** The Master Lead ID S29 parses (META|WA|OS prefix) so that the appended row round-trips to the same OS lead. */
export function masterLeadId(lead) {
  const lg = norm(lead.meta_leadgen_id);
  if (LEADGEN.test(lg)) return `META-${lg}`;
  const ref = leadRef(lead.id).toUpperCase();
  if (norm(lead.ctwa_clid) || lead.source === "whatsapp") return `WA-${ref}`;
  return `OS-${ref}`;
}
// The register only uses "FB Form" and "WhatsApp" for Meta intake; Instagram Instant Form leads are "FB Form" too.
const CHANNEL_LABEL = { fb: "FB Form", ins: "FB Form", whatsapp: "WhatsApp", website: "Website", referral: "Referral", show_room: "Showroom", offline: "Self-developed" };
export const intakeChannelLabel = (lead) => (LEADGEN.test(norm(lead.meta_leadgen_id)) ? "FB Form" : CHANNEL_LABEL[lead.source] ?? (norm(lead.ctwa_clid) ? "WhatsApp" : ""));
const INTAKE_SOURCES = new Set(["fb", "ins", "whatsapp", "website"]);

// ---------- which leads ----------
/**
 * leads: OS rows {id, created_at, archived, source, meta_leadgen_id, ctwa_clid, phone, email, import_fingerprint, drive_sync, register_append, ...}.
 * Returns {candidates (oldest first), skipped:{reason:count}}. Never looks at a lead created at or before the watermark.
 */
export function selectRegisterCandidates(leads, watermark) {
  const mark = Date.parse(watermark ?? "");
  const skipped = {}; const candidates = [];
  const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  if (!Number.isFinite(mark)) return { candidates, skipped: { no_watermark: leads.length } };
  for (const l of leads) {
    if (!(Date.parse(l.created_at ?? "") > mark)) { skip("before_watermark"); continue; }
    if (l.archived) { skip("archived"); continue; }
    if (l.register_append?.master_lead_id) { skip("already_marked"); continue; }
    if (l.drive_sync?.inserted_by || l.import_fingerprint) { skip("came_from_sheet"); continue; }
    if (!(LEADGEN.test(norm(l.meta_leadgen_id)) || norm(l.ctwa_clid) || INTAKE_SOURCES.has(l.source))) { skip("not_intake_source"); continue; }
    if (!phoneKey(l.phone) && !norm(l.email)) { skip("no_phone_or_email"); continue; }
    candidates.push(l);
  }
  candidates.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.id).localeCompare(String(b.id)));
  return { candidates, skipped };
}

// ---------- ids (AK..AN) ----------
const idCell = (prefix, v) => { const t = norm(v); return t ? `${prefix}${t}` : ""; };
/** Form lead: l:<leadgen>. WhatsApp click lead: ctwa:<ctwa_clid>. Campaign / adset / ad ids only when OS has them. Empty string = nothing to write. */
export function idFields(lead) {
  const lg = norm(lead.meta_leadgen_id);
  return {
    "Source lead ID": LEADGEN.test(lg) ? `l:${lg}` : idCell("ctwa:", lead.ctwa_clid),
    "Campaign ID": idCell("c:", lead.campaign_id), "Adset ID": idCell("as:", lead.adset_id), "Ad ID": idCell("ag:", lead.ad_id),
  };
}

// ---------- row ----------
export const receivedAt = (iso) => dubaiStamp(Date.parse(iso)); // "2026-11-20 14:05" Dubai time: S29 parses it as dubai_local
export function rowFields(lead) {
  return {
    "Master Lead ID": masterLeadId(lead), "Received at": receivedAt(lead.created_at), "Intake channel": intakeChannelLabel(lead),
    Client: norm(lead.customer_name), "Primary phone": norm(lead.phone), Email: norm(lead.email), Campaign: norm(lead.campaign_name), Ad: norm(lead.ad_name), ...idFields(lead),
  };
}
/** Sparse row up to the last written column; every other cell stays "" (left for people). */
export function buildRegisterRow(lead, head) {
  const f = rowFields(lead);
  const cols = WRITE_COLUMNS.map((n) => head.index[n]);
  const row = Array(Math.max(...cols) + 1).fill("");
  for (const n of WRITE_COLUMNS) row[head.index[n]] = f[n];
  return row;
}
export const noteAppended = (ms, ref) => `OS 写入 迪拜时间 ${dubaiStamp(ms)}｜来源：OS｜线索 ${maskRef(ref)}`;

// ---------- plan ----------
/** grid: register values from the header row (index 0). Row number of index i = headerRow + i. */
export function indexRegister(grid, head, headerRow = REGISTER.headerRow) {
  const col = (n) => head.index[n];
  const byMaster = new Map(); const byPhone = new Set(); const byLeadgen = new Set(); let lastRow = headerRow;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    if (!r.some((v) => norm(v))) continue;
    lastRow = headerRow + i;
    const m = norm(r[col("Master Lead ID")]);
    if (m) { if (!byMaster.has(m)) byMaster.set(m, headerRow + i); const lg = /^META-([1-9]\d{7,31})$/.exec(m)?.[1]; if (lg) byLeadgen.add(lg); }
    for (const k of phoneKeysFromCell(r[col("Primary phone")])) byPhone.add(k);
    for (const x of norm(r[col("Source lead ID")]).matchAll(/l:(\d{8,32})/g)) byLeadgen.add(x[1]);
  }
  return { byMaster, byPhone, byLeadgen, lastRow };
}

/**
 * Returns {appends:[{lead, master, row:[...]}], present:[{lead, master, sheetRow}], skipped:{reason:count}}.
 * present = already on the register by key (adopt: mark in OS, finish formatting, write nothing).
 */
export function planRegisterAppend(candidates, grid, head, { maxRows = REGISTER.maxAppendRows, pending = {}, allLeads = [] } = {}) {
  const idx = indexRegister(grid, head);
  const appends = []; const present = []; const skipped = {}; const droppedPending = [];
  const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const batchPhones = new Set(); const batchMails = new Set();
  for (const lead of candidates) {
    const master = masterLeadId(lead);
    if (idx.byMaster.has(master)) { present.push({ lead, master, sheetRow: idx.byMaster.get(master) }); continue; }
    const lg = norm(lead.meta_leadgen_id);
    if (lg && idx.byLeadgen.has(lg)) { skip("meta_id_in_register"); continue; }
    const keys = phoneKeysFromCell(lead.phone);
    if (keys.some((k) => idx.byPhone.has(k))) { skip("phone_in_register"); continue; }
    const mail = norm(lead.email).toLowerCase();
    if (keys.some((k) => batchPhones.has(k)) || (!keys.length && mail && batchMails.has(mail))) { skip("duplicate_in_batch"); continue; }
    keys.forEach((k) => batchPhones.add(k)); if (mail) batchMails.add(mail);
    appends.push({ lead, master, row: buildRegisterRow(lead, head) });
  }
  // Rows this program appended earlier whose OS mark / colour did not finish (crash, or the lead was archived since): adopt them.
  for (const [master, p] of Object.entries(pending)) {
    if (present.some((x) => x.master === master)) continue;
    const lead = allLeads.find((l) => l.id === p.lead_id);
    if (lead && idx.byMaster.has(master)) present.push({ lead, master, sheetRow: idx.byMaster.get(master) });
    else if (!idx.byMaster.has(master)) droppedPending.push(master); // the append never landed: the lead is looked at again as a new candidate
  }
  return { appends, present, skipped, droppedPending, lastRow: idx.lastRow, overLimit: Math.max(0, appends.length - maxRows) };
}

/** Provenance ops for one appended row: light blue + note on each cell this program wrote (non-empty), nothing else. */
export function formatOpsFor(sheetRow, row, ms, ref) {
  const note = noteAppended(ms, ref);
  return row.flatMap((v, c) => (v === "" ? [] : [{ kind: "cell", row: sheetRow, col: c, bg: BLUE, note }]));
}

/** What read-back must find on the sheet for an appended row: {col, value}. */
export const expectedCells = (row) => row.flatMap((v, c) => (v === "" ? [] : [{ col: c, value: v }]));
export const fingerprintForMaster = (master) => fingerprintOf(master);


// ---------- one-off backfill of AK..AN on rows this program appended for WhatsApp leads ----------
export const BACKFILL_MASTER_PREFIX = "WA-NM-";
export const noteBackfilled = (ms, ref) => `OS 补写编号 迪拜时间 ${dubaiStamp(ms)}｜来源：OS｜线索 ${maskRef(ref)}`;
/**
 * grid: register from the header row (index 0). leads: OS rows {id, ctwa_clid, meta_leadgen_id, campaign_id, adset_id, ad_id}.
 * Plans ONLY cells in AK..AN that are empty on rows whose Master Lead ID starts with WA-NM- and whose lead OS knows.
 * A cell that holds anything (a person's value included) is never planned. A Master Lead ID that is on the sheet twice is skipped.
 * Returns {cells:[{row, col, name, value, ref}], rows, skipped:{reason:count}}.
 */
export function planIdBackfill(grid, head, leads, headerRow = REGISTER.headerRow) {
  const byRef = new Map(leads.map((l) => [leadRef(l.id).toLowerCase(), l]));
  const mi = head.index["Master Lead ID"];
  const count = new Map();
  for (let i = 1; i < grid.length; i++) { const m = norm(grid[i]?.[mi]); if (m.startsWith(BACKFILL_MASTER_PREFIX)) count.set(m, (count.get(m) ?? 0) + 1); }
  const cells = []; const skipped = {}; const rows = new Set();
  const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? []; const m = norm(r[mi]);
    if (!m.startsWith(BACKFILL_MASTER_PREFIX)) continue;
    if (count.get(m) > 1) { skip("duplicate_master_id"); continue; }
    const l = byRef.get(m.slice(3).toLowerCase());
    if (!l) { skip("lead_not_found"); continue; }
    const f = idFields(l); let any = false;
    for (const name of ID_COLUMNS) {
      const c = head.index[name];
      if (!f[name]) continue;
      if (norm(r[c]) !== "") { skip("cell_not_empty"); continue; }
      cells.push({ row: headerRow + i, col: c, name, value: f[name], ref: leadRef(l.id) }); rows.add(headerRow + i); any = true;
    }
    if (!any) skip("nothing_to_fill");
  }
  return { cells, rows: [...rows], skipped };
}
