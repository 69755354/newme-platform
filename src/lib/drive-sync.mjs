// Drive sheets -> OS sync (S29): the pure rules shared by the reader script (scripts/drive-to-os-sync.mjs) and the
// ingest route (src/app/api/sync/drive-ingest/route.ts). No I/O in here, so node:test covers every rule.
// Parsing, phone normalisation and the import fingerprint are the ones of the one-time backfill (review/reimport/import_sheets.mjs)
// so rows imported by the backfill are matched, not duplicated.
import { createHash, timingSafeEqual } from "node:crypto";

export const IMPORT_VERSION = "newme/sheet-reimport/v1"; // same value as the backfill: same fingerprint for the same Master Lead ID
export const SYNC_SOURCE = "drive_sync";
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_MAX_CHANGES_PER_CALL = 100;
export const DEFAULT_MAX_WRITES_PER_RUN = 300;
export const TOLERANCE_MS = 5000; // our own write bumps updated_at a moment after synced_at

export const norm = (v) => String(v ?? "").replace(/ /g, " ").trim();
export const sha = (s) => createHash("sha256").update(s).digest("hex");
export const fingerprintOf = (master) => sha(`${IMPORT_VERSION}/${master}`);
const key = (v) => norm(v).toLowerCase();

export function maskId(v) {
  const s = norm(v);
  if (!s) return "(none)";
  return s.length <= 6 ? `${s.slice(0, 1)}***` : `${s.slice(0, 3)}***${s.slice(-3)}`;
}

export function normalizePhone(raw) {
  let s = norm(raw).replace(/[\s().\-/]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^05\d{8}$/.test(s)) s = `+971${s.slice(1)}`;
  else if (/^5\d{8}$/.test(s)) s = `+971${s}`;
  else if (/^971\d{8,9}$/.test(s)) s = `+${s}`;
  else if (/^9710\d{9}$/.test(s)) s = `+971${s.slice(4)}`;
  else if (/^\+9710\d{9}$/.test(s)) s = `+971${s.slice(5)}`;
  if (!/^\+\d{7,15}$/.test(s)) return null;
  return { e164: s, digits: s.replace(/\D/g, "") };
}
export const phoneDigits = (raw) => normalizePhone(raw)?.digits ?? (norm(raw).replace(/\D/g, "").length >= 7 ? norm(raw).replace(/\D/g, "").replace(/^0+/, "") : null);
export const emailKey = (raw) => { const e = key(raw); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null; };

const DUBAI = "+04:00";
function dubai(y, mo, d, h, mi, se, kind) {
  const p = (n) => String(n ?? 0).padStart(2, "0");
  const t = Date.parse(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(se)}${DUBAI}`);
  return Number.isFinite(t) ? { iso: new Date(t).toISOString(), kind } : { iso: null, kind: "invalid" };
}
export function parseSheetTime(raw) {
  const s = norm(raw);
  if (!s) return { iso: null, kind: "empty" };
  let m;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? { iso: new Date(t).toISOString(), kind: "iso_offset" } : { iso: null, kind: "invalid" }; }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/))) return dubai(m[1], m[2], m[3], m[4], m[5], m[6], "dubai_local");
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return dubai(m[1], m[2], m[3], 0, 0, 0, "date_only");
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/))) return dubai(m[3], m[2], m[1], m[4] || 0, m[5] || 0, 0, m[4] ? "dmy_time" : "date_only");
  if ((m = s.match(/^(\d{1,2})\s*(\d{1,2})月\s*(\d{4})$/))) return dubai(m[3], m[2], m[1], 0, 0, 0, "date_only");
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*(上午|下午)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) { let h = Number(m[5]) % 12; if (m[4] === "下午") h += 12; return dubai(m[1], m[2], m[3], h, m[6], m[7] || 0, "zh_ampm"); }
  if ((m = s.match(/^(\d{1,2})-(\d{1,2})$/))) return dubai(2026, m[1], m[2], 0, 0, 0, "month_day_no_year");
  if (/^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); if (n < 40000 || n > 60000) return { iso: null, kind: "invalid" }; return { iso: new Date(Math.round((n - 25569) * 86400000) - 4 * 3600000).toISOString(), kind: "serial" }; }
  return { iso: null, kind: "invalid" };
}

// Lead quality values of the sheets -> OS values. "pending" (not assessed) is never written: it would blank a real value.
export const QUALITY_MAP = { good: "good", normal: "normal", nurture: "normal", poor: "poor", low: "poor", invalid: "fake", fake: "fake", duplicate: "duplicate", "job seeker": "job_seeker", valid: "valid" };
export const CHANNEL_SOURCE = { "fb form": "fb", facebook: "fb", "face book": "fb", "meta ads": "fb", instagram: "ins", ig: "ins", whatsapp: "whatsapp", referral: "referral", "self-developed": "offline", showroom: "show_room", "show room": "show_room", website: "website", "existing portfolio": "unknown_import", imported: "unknown_import", "company assigned": "unknown_import" };
export const OS_SOURCES = new Set(["ins", "fb", "show_room", "whatsapp", "website", "offline", "referral", "other", "unknown_import", "unknown"]);
export const OWNED_FIELDS = Object.freeze(["quality", "quality_reason", "next_action", "next_followup_date"]); // Drive/sales owns these
export const OS_OWNED = Object.freeze(["id", "source", "ad_id", "campaign_id", "meta_leadgen_id", "assigned_to", "stage", "final_status", "milestones", "contract"]);

export function tokenMatches(provided, expected) {
  if (typeof expected !== "string" || expected.length < MIN_TOKEN_LENGTH) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}
export function bearerToken(headers) {
  return (headers.get("authorization") ?? "").match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
}

const FLAG = (v, d = false) => (v == null || v === "" ? d : String(v).toLowerCase() === "true");
export function resolveConfig(env = process.env) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.floor(x) : d; };
  return {
    enabled: FLAG(env.DRIVE_SYNC_INGEST_ENABLED, false),
    allowInsert: FLAG(env.DRIVE_SYNC_ALLOW_INSERT, false),
    allowUnarchive: FLAG(env.DRIVE_SYNC_ALLOW_UNARCHIVE, false),
    writeNextDate: FLAG(env.DRIVE_SYNC_WRITE_NEXT_DATE, false), // true makes the lead trigger create follow-up tasks
    maxChangesPerCall: n(env.DRIVE_SYNC_MAX_CHANGES_PER_CALL, DEFAULT_MAX_CHANGES_PER_CALL),
    maxWritesPerRun: n(env.DRIVE_SYNC_MAX_WRITES, DEFAULT_MAX_WRITES_PER_RUN),
  };
}

/** Hash of the Drive-owned content of one row. Unchanged hash = nothing new to apply (idempotency). */
export function rowHashOf(change) {
  const o = change.owned ?? {};
  return sha(JSON.stringify([o.quality ?? "", o.quality_reason ?? "", o.next_action ?? "", o.next_followup_date ?? "", change.followup_text ?? "", change.contact_note ?? "", change.first_contact_at ?? "", change.contact_rule ?? ""]));
}

const nonEmpty = (v) => v !== null && v !== undefined && norm(v) !== "";
const isFrozenFinal = (lead) => ["won", "lost"].includes(lead.final_status) || ["won", "lost"].includes(lead.stage);

/** Validate the shape of one change coming over the wire. Returns an error string or null. */
export function validateChange(c) {
  if (!c || typeof c !== "object") return "not_an_object";
  if (typeof c.key !== "string" || !c.key || c.key.length > 200) return "bad_key";
  if (typeof c.sheet !== "string" || c.sheet.length > 60) return "bad_sheet";
  if (!Number.isInteger(c.row) || c.row < 1) return "bad_row";
  if (c.source_modified_at != null && !Number.isFinite(Date.parse(c.source_modified_at))) return "bad_source_modified_at";
  if (c.owned != null && typeof c.owned !== "object") return "bad_owned";
  for (const f of ["followup_text", "contact_note"]) if (c[f] != null && (typeof c[f] !== "string" || c[f].length > 8000)) return `bad_${f}`;
  if (c.identity != null && typeof c.identity !== "object") return "bad_identity";
  return null;
}

export function buildIndexes(leads) {
  const byFp = new Map(), byLeadgen = new Map(), byPhone = new Map(), byEmail = new Map();
  for (const l of leads) {
    if (l.import_fingerprint) byFp.set(l.import_fingerprint, l);
    if (l.meta_leadgen_id) byLeadgen.set(String(l.meta_leadgen_id), l);
    const pk = phoneDigits(l.phone); if (pk) (byPhone.get(pk) || byPhone.set(pk, []).get(pk)).push(l);
    const ek = emailKey(l.email); if (ek) (byEmail.get(ek) || byEmail.set(ek, []).get(ek)).push(l);
  }
  return { byFp, byLeadgen, byPhone, byEmail };
}

/** Find the OS lead of a change: fingerprint, Meta lead id, phone, e-mail (same order as the backfill). */
export function matchLead(change, idx) {
  const id = change.identity ?? {};
  if (id.fingerprint && idx.byFp.has(id.fingerprint)) return { lead: idx.byFp.get(id.fingerprint), by: "fingerprint" };
  if (id.leadgen && idx.byLeadgen.has(String(id.leadgen))) return { lead: idx.byLeadgen.get(String(id.leadgen)), by: "meta_leadgen_id" };
  const pk = id.phone_digits || phoneDigits(id.phone);
  const ek = emailKey(id.email);
  const cands = [...(pk ? idx.byPhone.get(pk) || [] : []), ...(ek ? idx.byEmail.get(ek) || [] : [])];
  const uniq = [...new Map(cands.map((l) => [l.id, l])).values()];
  if (uniq.length > 1) return { ambiguous: uniq.length };
  if (uniq.length === 1) return { lead: uniq[0], by: pk && (idx.byPhone.get(pk) || []).includes(uniq[0]) ? "phone" : "email" };
  return {};
}

/**
 * Decide what to do with one change. Pure. `claimed` (Map leadId -> key) stops two sheet rows from writing the same lead.
 * Returns { action: insert|update|noop|skip|hold, reason?, set?, raw_patch?, notes?, conflicts?, fields?, lead_id?, unarchive? }.
 */
export function decideChange(change, idx, cfg, claimed = new Map()) {
  if (change.skip_reason) return { action: "skip", reason: change.skip_reason };
  if (change.hold_reason) return { action: "hold", reason: change.hold_reason };
  const m = matchLead(change, idx);
  if (m.ambiguous) return { action: "hold", reason: `ambiguous_match_${m.ambiguous}` };
  const hash = rowHashOf(change);
  const owned = change.owned ?? {};
  if (!m.lead) {
    if (!change.insertable) return { action: "hold", reason: "not_in_os_match_only" };
    if (!cfg.allowInsert) return { action: "hold", reason: "insert_disabled", would: "insert" };
    if (!change.identity?.phone_digits && !change.identity?.email) return { action: "hold", reason: "no_identity" };
    const set = {};
    if (nonEmpty(owned.next_action)) set.next_action = norm(owned.next_action);
    if (owned.quality === "poor" && nonEmpty(owned.quality_reason)) set.poor_reason = norm(owned.quality_reason);
    if (cfg.writeNextDate && nonEmpty(owned.next_followup_date)) set.next_followup_date = norm(owned.next_followup_date);
    return { action: "insert", row_hash: hash, set, notes: notesOf(change), raw_patch: rawPatchOf(change, hash) };
  }
  const lead = m.lead;
  if (claimed.has(lead.id) && claimed.get(lead.id) !== change.key) return { action: "hold", reason: "two_rows_same_lead", lead_id: lead.id };
  claimed.set(lead.id, change.key);
  if (lead.archived && !cfg.allowUnarchive) return { action: "hold", reason: "archived_frozen", lead_id: lead.id };
  const prev = lead.drive_sync ?? null;
  if (prev?.row_hash === hash && !(lead.archived && cfg.allowUnarchive)) return { action: "noop", reason: "unchanged_since_last_sync", lead_id: lead.id, matched_by: m.by };

  const sheetAt = change.source_modified_at ? Date.parse(change.source_modified_at) : null;
  const osAt = lead.updated_at ? Date.parse(lead.updated_at) : null;
  const syncedAt = prev?.synced_at ? Date.parse(prev.synced_at) : null;
  const osChangedSince = osAt != null && (syncedAt == null || osAt - syncedAt > TOLERANCE_MS);
  const set = {}; const conflicts = []; const fields = [];
  const current = { quality: lead.quality, next_action: lead.next_action, quality_reason: lead.poor_reason, next_followup_date: cfg.writeNextDate ? lead.next_followup_date : prev?.next_followup_date };
  for (const f of OWNED_FIELDS) {
    const v = norm(owned[f]);
    if (!nonEmpty(v)) continue; // empty never overwrites
    if (f === "quality" && (v === "pending" || v === lead.quality)) continue;
    if (f === "quality" && lead.quality && lead.quality !== "pending" && isFrozenFinal(lead)) continue;
    const cur = current[f];
    if (norm(cur) === v) continue;
    // Conflict: OS holds a different non-empty value that changed after the last sync. Later modified wins.
    if (nonEmpty(cur) && osChangedSince && !(sheetAt != null && osAt != null && sheetAt > osAt)) { conflicts.push({ field: f, winner: "os" }); continue; }
    if (nonEmpty(cur) && osChangedSince) conflicts.push({ field: f, winner: "drive" });
    fields.push(f);
    if (f === "quality") set.quality = v;
    else if (f === "next_action") set.next_action = v;
    else if (f === "quality_reason" && v && v !== "") { if ((set.quality ?? lead.quality) === "poor") set.poor_reason = v; }
    else if (f === "next_followup_date" && cfg.writeNextDate) set.next_followup_date = v;
  }
  const notes = notesOf(change);
  const raw_patch = rawPatchOf(change, hash);
  const unarchive = !!(lead.archived && cfg.allowUnarchive);
  // A write happens whenever the row changed since the last sync: at least the sync state and the note go in.
  return { action: "update", lead_id: lead.id, matched_by: m.by, set, fields, conflicts, notes, raw_patch, unarchive, row_hash: hash };
}

function notesOf(change) {
  return nonEmpty(change.followup_text) ? [{ import_key: `${change.key}/daily-feedback`, type: "note", content: `[Sheet sales feedback] ${norm(change.followup_text)}`.slice(0, 4000) }] : [];
}
function rawPatchOf(change, hash) {
  const owned = change.owned ?? {};
  return { drive_sync: { row_hash: hash, synced_at: null /* the route stamps the write time */, key: change.key, sheet: change.sheet, row: change.row, quality_reason: owned.quality_reason ?? undefined, next_followup_date: owned.next_followup_date ?? undefined, contact_days_filled: change.contact_days_filled ?? undefined, first_contact_at: change.first_contact_at ?? undefined, contact_rule: change.contact_rule ?? undefined, source_modified_at: change.source_modified_at ?? undefined } };
}
/** Number of database writes one decision costs (lead update + activities), for the per-run cap. */
export function writeCost(d) {
  if (d.action === "insert") return 3 + (d.notes?.length ?? 0);
  if (d.action === "update") return 1 + (d.notes?.length ?? 0) + 1;
  return 0;
}

/** Plan a whole batch: decisions + counts. Also used by the route for dry runs. */
export function planBatch(changes, leads, cfg) {
  const idx = buildIndexes(leads); const claimed = new Map();
  const decisions = changes.map((c) => ({ change: c, d: decideChange(c, idx, cfg, claimed) }));
  const counts = { read: changes.length, matched: 0, inserted: 0, would_insert: 0, updated: 0, noop: 0, skipped: 0, held: 0, conflicts: 0, writes: 0 };
  for (const { d } of decisions) {
    if (d.lead_id) counts.matched += 1;
    if (d.action === "insert") counts.inserted += 1; else if (d.action === "update") counts.updated += 1; else if (d.action === "noop") counts.noop += 1; else if (d.action === "skip") counts.skipped += 1; else if (d.action === "hold") { counts.held += 1; if (d.would === "insert") counts.would_insert += 1; }
    counts.conflicts += d.conflicts?.length ?? 0; counts.writes += writeCost(d);
  }
  return { decisions, counts };
}
