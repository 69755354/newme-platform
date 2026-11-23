// Drive sheets -> OS sync (S29): the pure rules shared by the reader script (scripts/drive-to-os-sync.mjs) and the
// ingest route (src/app/api/sync/drive-ingest/route.ts). No I/O in here, so node:test covers every rule.
// Parsing, phone normalisation and the import fingerprint are the ones of the one-time backfill (review/reimport/import_sheets.mjs)
// so rows imported by the backfill are matched, not duplicated.
import { createHash, timingSafeEqual } from "node:crypto";
import { intakePhone } from "./lead-contact.mjs";
import { planSheetQuote, shouldAdvanceStageForQuote } from "./sheet-quote.mjs";

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
  // S39: the shared reader first; the sheet's own lenient rule stays as the fallback for numbers it refuses.
  const shared = intakePhone(raw);
  if (shared && /^\+\d{7,15}$/.test(shared)) return { e164: shared, digits: shared.replace(/\D/g, "") };
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
// Narrow, documented exception to OS ownership (PURCHASE-CAPI-20261120.md): a sheet row whose "Opportunity stage" says a
// quotation was reported, with "Quote value AED" > 0, (a) stores leads.quotation_value (never over a value OS changed itself)
// and (b) queues the Meta feedback for the quote, and (c) asks the database to move the lead forward to quotation_submitted
// (decision.stage_advance; the ingest route calls the service-role routine sync_advance_lead_stage_from_sheet, S33: forward
// only, one audited step at a time, never past quotation_submitted). The audited stage routine for people needs a signed-in
// actor and direct writes are blocked by the stage triggers, hence that routine. Won / lost / archived leads are never touched.
export const QUOTE_STAGES = Object.freeze(["quotation reported", "quote reported"]);
// Strict: only a plain amount, optionally with an AED/Dhs label and thousands separators. Anything else ("12k", "1.2M",
// "TBD", ranges, negatives) is not a quote, so a mis-typed cell never reaches Meta as a wrong value.
export const moneyNumber = (raw) => {
  const t = norm(raw).replace(/^(aed|dhs?|د\.إ)\s*/i, "").replace(/\s*(aed|dhs?|د\.إ)$/i, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t); return Number.isFinite(n) && n > 0 ? n : null;
};
export const isQuoteReported = (change) => QUOTE_STAGES.includes(key(change?.opp_stage)) && moneyNumber(change?.quote_value) !== null;
export const OS_OWNED = Object.freeze(["id", "source", "ad_id", "campaign_id", "meta_leadgen_id", "assigned_to", "stage", "final_status", "milestones", "contract"]);
// Narrow exception to OS ownership of the Meta ids (link-meta-ids): a sheet row that carries the Meta lead id (AJ META-... / AK l:...)
// or the campaign / adset / ad ids fills them on the OS lead ONLY while the OS value is empty. A non-empty OS value is never
// overwritten (a different one is reported as a conflict), and a leadgen id already held by another lead is never copied (unique index).
// The columns exist (no migration) and no trigger guards them for the service-role writer (only ctwa_clid / wa_* are guarded).
export const META_ID_FIELDS = Object.freeze(["meta_leadgen_id", "campaign_id", "adset_id", "ad_id"]);
export const META_ID_AD_FIELDS = Object.freeze(["campaign_id", "adset_id", "ad_id"]);
const META_ID_RE = { meta_leadgen_id: /^[1-9]\d{7,31}$/, campaign_id: /^\d{5,32}$/, adset_id: /^\d{5,32}$/, ad_id: /^\d{5,32}$/ };
/** "l:123" / "c:123" / "as:123" / "ag:123" / "123" -> "123"; anything that is not a plain numeric Meta id -> null. */
export const cleanMetaId = (field, raw) => { const t = norm(raw).replace(/^(l|c|as|ag):/i, ""); return META_ID_RE[field]?.test(t) ? t : null; };

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
  return sha(JSON.stringify([o.quality ?? "", o.quality_reason ?? "", o.next_action ?? "", o.next_followup_date ?? "", change.followup_text ?? "", change.contact_note ?? "", change.first_contact_at ?? "", change.contact_rule ?? "", key(change.opp_stage), moneyNumber(change.quote_value) ?? "", ...(nonEmpty(change.sheet_owner) ? [norm(change.sheet_owner)] : [])])); // owner only when present: rows without one keep their old hash
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
  for (const f of ["opp_stage", "quote_value"]) if (c[f] != null && (typeof c[f] !== "string" && typeof c[f] !== "number" || String(c[f]).length > 60)) return `bad_${f}`;
  if (c.sheet_owner != null && (typeof c.sheet_owner !== "string" || c.sheet_owner.length > 60)) return "bad_sheet_owner";
  for (const f of ["followup_text", "contact_note"]) if (c[f] != null && (typeof c[f] !== "string" || c[f].length > 8000)) return `bad_${f}`;
  if (c.identity != null && typeof c.identity !== "object") return "bad_identity";
  if (c.meta_ids != null) { if (typeof c.meta_ids !== "object" || Array.isArray(c.meta_ids)) return "bad_meta_ids"; for (const v of Object.values(c.meta_ids)) if (v != null && (typeof v !== "string" || v.length > 64)) return "bad_meta_ids"; }
  if (c.quote_at != null && (typeof c.quote_at !== "string" || !Number.isFinite(Date.parse(c.quote_at)))) return "bad_quote_at";
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
 * Meta ids the sheet row carries and the OS lead still lacks. Pure. Never overwrites a non-empty OS value (a different value is a
 * conflict, winner "os"); never copies a leadgen id that another lead holds or that another row of the run already claimed,
 * and fills each empty column of a lead from one row of the run only (two rows matching the same lead must not both fill it).
 * Returns { set, conflicts } (set: only columns to fill).
 */
export function planMetaIds(change, lead, idx, claimed, tag = claimTag(change.key)) {
  const want = change.meta_ids ?? {}; const set = {}; const conflicts = [];
  for (const f of META_ID_FIELDS) {
    const v = cleanMetaId(f, want[f] ?? (f === "meta_leadgen_id" ? change.identity?.leadgen : null));
    if (!v) continue;
    const cur = norm(lead[f]);
    if (cur) { if (cur !== v) conflicts.push({ field: f, winner: "os" }); continue; }
    if (f === "meta_leadgen_id") {
      const other = idx.byLeadgen.get(v); const ck = `leadgen:${v}`;
      if ((other && other.id !== lead.id) || (claimed.has(ck) && claimed.get(ck) !== String(lead.id))) { conflicts.push({ field: f, winner: "os", reason: "held_by_other_lead" }); continue; }
    }
    const fk = `fill:${lead.id}:${f}`;
    if (claimed.has(fk) && claimed.get(fk) !== tag) { conflicts.push({ field: f, winner: "os", reason: "filled_by_other_row" }); continue; }
    if (f === "meta_leadgen_id") claimed.set(`leadgen:${v}`, String(lead.id));
    claimed.set(fk, tag);
    set[f] = v;
  }
  return { set, conflicts };
}

/**
 * Decide what to do with one change. Pure. `claimed` (Map leadId / identity tag -> claimTag(key)) stops two sheet rows from
 * writing the same lead, and two rows of the same new person from both being inserted.
 * Returns { action: insert|update|noop|skip|hold, reason?, set?, raw_patch?, notes?, conflicts?, fields?, lead_id?, unarchive? }.
 */
export function decideChange(change, idx, cfg, claimed = new Map()) {
  if (change.skip_reason) return { action: "skip", reason: change.skip_reason };
  if (change.hold_reason) return { action: "hold", reason: change.hold_reason };
  const m = matchLead(change, idx);
  if (change.ids_only && !m.lead) return { action: "skip", reason: "marketing_no_drive_owned_content" }; // form row with only ids: nothing to insert or hold
  if (m.ambiguous) return change.ids_only ? { action: "skip", reason: "marketing_no_drive_owned_content" } : { action: "hold", reason: `ambiguous_match_${m.ambiguous}` };
  const hash = rowHashOf(change);
  const owned = change.owned ?? {};
  const tag = claimTag(change.key);
  if (!m.lead) {
    if (!change.insertable) return { action: "hold", reason: "not_in_os_match_only" };
    if (!cfg.allowInsert) return { action: "hold", reason: "insert_disabled", would: "insert" };
    if (!change.identity?.phone_digits && !change.identity?.email) return { action: "hold", reason: "no_identity" };
    // The same new person on two rows (same phone / e-mail / key) is inserted once; the other row is held.
    const ids = identityClaimsOf(change);
    if (ids.some((k) => claimed.has(k))) return { action: "hold", reason: "ambiguous_new_person_already_planned" };
    for (const k of ids) claimed.set(k, tag);
    const set = {};
    if (nonEmpty(owned.next_action)) set.next_action = norm(owned.next_action);
    if (owned.quality === "poor" && nonEmpty(owned.quality_reason)) set.poor_reason = norm(owned.quality_reason);
    if (cfg.writeNextDate && nonEmpty(owned.next_followup_date)) set.next_followup_date = norm(owned.next_followup_date);
    // A quote already in the sheet when the lead is first seen is history: stored, never sent to Meta.
    const quoted = isQuoteReported(change);
    if (quoted) set.quotation_value = moneyNumber(change.quote_value);
    return { action: "insert", row_hash: hash, set, notes: notesOf(change), raw_patch: rawPatchOf(change, hash, null, {}, quoted ? { state: "baseline_skipped", value: set.quotation_value } : { baseline: true }), claim_tag: tag };
  }
  const lead = m.lead;
  // A row that only carries Meta ids (market sheet form row without Drive-owned text) never takes the lead's claim: the
  // lead's own register / sales row stays free to write its fields in the same run.
  if (!change.ids_only) {
    if (claimed.has(lead.id) && claimed.get(lead.id) !== tag) return { action: "hold", reason: "ambiguous_two_rows_same_lead", lead_id: lead.id };
    claimed.set(lead.id, tag);
  }
  if (lead.archived && !cfg.allowUnarchive) return change.ids_only ? { action: "skip", reason: "marketing_no_drive_owned_content" } : { action: "hold", reason: "archived_frozen", lead_id: lead.id };
  const prev = lead.drive_sync ?? null;
  const metaIds = planMetaIds(change, lead, idx, claimed, tag);
  const idsToFill = Object.keys(metaIds.set).length > 0;
  if (change.ids_only && !idsToFill) return metaIds.conflicts.length ? { action: "noop", reason: "meta_id_conflict", lead_id: lead.id, matched_by: m.by, conflicts: metaIds.conflicts } : { action: "skip", reason: "marketing_no_drive_owned_content" };
  // The sheet owner joined the row hash on 2026-11-21 (only when present). A row whose stored hash still matches without the
  // owner changed nothing else: record the owner and the new hash only (one write; no field re-apply, no sync note).
  if (prev?.quote_baseline && prev.row_hash !== hash && !idsToFill && !(lead.archived && cfg.allowUnarchive) && nonEmpty(change.sheet_owner) && prev.row_hash === rowHashOf({ ...change, sheet_owner: undefined })) return { action: "rehash", reason: "sheet_owner_recorded", lead_id: lead.id, matched_by: m.by, row_hash: hash, raw_patch: { drive_sync: { row_hash: hash, sheet_owner: change.sheet_owner, os_won: osWonForUnchangedRow(change, lead, prev, cfg) } } };
  if (prev?.row_hash === hash && prev?.quote_baseline && !idsToFill && !(lead.archived && cfg.allowUnarchive)) return { action: "noop", reason: "unchanged_since_last_sync", lead_id: lead.id, matched_by: m.by, ...(metaIds.conflicts.length ? { conflicts: metaIds.conflicts } : {}) };

  const sheetAt = change.source_modified_at ? Date.parse(change.source_modified_at) : null;
  const osAt = lead.updated_at ? Date.parse(lead.updated_at) : null;
  const syncedAt = prev?.synced_at ? Date.parse(prev.synced_at) : null;
  const osChangedSince = osAt != null && (syncedAt == null || osAt - syncedAt > TOLERANCE_MS);
  const set = {}; const conflicts = []; const fields = [];
  // OS-won fields stay OS-won while the Drive value is the one that lost (our own write refreshes synced_at/updated_at,
  // so without this record the next unrelated Drive edit would overwrite them).
  const prevOsWon = prev?.os_won ?? {}; const osWon = {};
  const current = { quality: lead.quality, next_action: lead.next_action, quality_reason: lead.poor_reason, next_followup_date: cfg.writeNextDate ? lead.next_followup_date : prev?.next_followup_date };
  for (const f of OWNED_FIELDS) {
    const v = norm(owned[f]);
    if (!nonEmpty(v)) continue; // empty never overwrites
    if (f === "quality" && (v === "pending" || v === lead.quality)) continue;
    if (f === "quality" && lead.quality && lead.quality !== "pending" && isFrozenFinal(lead)) continue;
    const cur = current[f];
    if (norm(cur) === v) continue;
    if (nonEmpty(cur) && prevOsWon[f] === valueTag(v)) { osWon[f] = prevOsWon[f]; continue; }
    // Conflict: OS holds a different non-empty value that changed after the last sync. Later modified wins.
    if (nonEmpty(cur) && osChangedSince && !(sheetAt != null && osAt != null && sheetAt > osAt)) { conflicts.push({ field: f, winner: "os" }); osWon[f] = valueTag(v); continue; }
    if (nonEmpty(cur) && osChangedSince) conflicts.push({ field: f, winner: "drive" });
    fields.push(f);
    if (f === "quality") set.quality = v;
    else if (f === "next_action") set.next_action = v;
    else if (f === "quality_reason" && v && v !== "") { if ((set.quality ?? lead.quality) === "poor") set.poor_reason = v; }
    else if (f === "next_followup_date" && cfg.writeNextDate) set.next_followup_date = v;
  }
  const notes = notesOf(change);
  // A blank Drive cell keeps an earlier OS-won record (the empty value never overwrote anything).
  for (const f of OWNED_FIELDS) if (!nonEmpty(owned[f]) && prevOsWon[f]) osWon[f] = prevOsWon[f];
  // Quote reported in the sheet: store the amount (forward-only information; OS-edited values win) and queue the Meta event
  // once, only for a quote that appeared after the lead was already baselined (older quotes are history: 7-day Meta window).
  let quote = null; let quotePatch = { baseline: true }; let stageAdvance = false;
  if (isQuoteReported(change) && !isFrozenFinal(lead) && !lead.archived) {
    const amount = moneyNumber(change.quote_value);
    // The stage follows the sheet whether the quote is new or history: moving the OS stage has no Meta time window.
    stageAdvance = shouldAdvanceStageForQuote(lead);
    const osValue = Number(lead.quotation_value) || 0;
    const osEdited = osValue > 0 && osValue !== Number(prev?.quote_value ?? 0);
    if (!osEdited && osValue !== amount) { set.quotation_value = amount; fields.push("quotation_value"); }
    if (!prev?.quote_baseline) quotePatch = { state: "baseline_skipped", value: amount };
    else if (!prev?.quote_state) {
      const verdict = planSheetQuote({ lead, sheet: { amount }, firstSeenIso: new Date(cfg.nowMs ?? Date.now()).toISOString(), nowMs: cfg.nowMs ?? Date.now() });
      if (verdict.action === "queue") { quote = { value: verdict.value, currency: verdict.currency, eventTime: verdict.eventTime, stage_pending: verdict.advanceStage }; quotePatch = { state: "queued", value: amount, at: new Date(verdict.eventTime * 1000).toISOString() }; }
      else quotePatch = { state: `skipped_${verdict.reason}`, value: amount };
    } else quotePatch = { value: amount };
  }
  // Meta ids (only ever filling empty OS columns), then the late quote event: a lead that has just gained its leadgen id AND
  // already carries a quote value enqueues the form-lead quote event once, stamped with the quote's own time, and only while
  // that time is inside Meta's 7-day window; an older (or undated) quote is recorded as not sendable, never sent stale.
  Object.assign(set, metaIds.set); fields.push(...Object.keys(metaIds.set)); conflicts.push(...metaIds.conflicts);
  let quoteLate = null; let quoteMeta = null;
  if (metaIds.set.meta_leadgen_id && !prev?.quote_meta && !isFrozenFinal(lead) && !lead.archived) {
    const amount = moneyNumber(change.quote_value) ?? (Number(lead.quotation_value) > 0 ? Number(lead.quotation_value) : null);
    if (amount && quote) quoteMeta = { state: "sent_with_quote", value: amount }; // the ordinary quote path sends it right after this write
    else if (amount) {
      const at = change.quote_at ?? prev?.quote_at ?? null;
      if (!at) quoteMeta = { state: "not_sendable_no_quote_date", value: amount };
      else {
        const verdict = planSheetQuote({ lead, sheet: { amount, quotedAtIso: at }, firstSeenIso: at, nowMs: cfg.nowMs ?? Date.now() });
        if (verdict.action === "queue") { quoteLate = { value: verdict.value, currency: verdict.currency, eventTime: verdict.eventTime }; quoteMeta = { state: "sent_after_link", value: amount, at: new Date(verdict.eventTime * 1000).toISOString() }; }
        else quoteMeta = { state: `not_sendable_${verdict.reason}`, value: amount };
      }
    }
  }
  const raw_patch = rawPatchOf(change, hash, prev, osWon, quotePatch, { ids_filled: Object.keys(metaIds.set), quote_meta: quoteMeta?.state, quote_meta_value: quoteMeta?.value, quote_meta_at: quoteMeta?.at });
  const unarchive = !!(lead.archived && cfg.allowUnarchive);
  // A write happens whenever the row changed since the last sync: at least the sync state and the note go in.
  return { action: "update", lead_id: lead.id, matched_by: m.by, set, fields, conflicts, notes, raw_patch, unarchive, row_hash: hash, ...(quote ? { quote } : {}), ...(stageAdvance ? { stage_advance: true } : {}), ...(idsToFill ? { ids_gained: Object.keys(metaIds.set) } : {}), ...(quoteLate ? { quote_late: quoteLate } : {}), ...(quoteMeta ? { quote_meta_state: quoteMeta.state } : {}) };
}

function notesOf(change) {
  return nonEmpty(change.followup_text) ? [{ import_key: `${change.key}/daily-feedback`, type: "note", content: `[Sheet sales feedback] ${norm(change.followup_text)}`.slice(0, 4000) }] : [];
}
function rawPatchOf(change, hash, prev, osWon, q = {}, x = {}) {
  const owned = change.owned ?? {};
  return { drive_sync: mergeDriveSync(prev, { row_hash: hash, synced_at: null /* the route stamps the write time */, key: change.key, sheet: change.sheet, row: change.row, quality_reason: owned.quality_reason, next_followup_date: owned.next_followup_date, contact_days_filled: change.contact_days_filled, first_contact_at: change.first_contact_at, contact_rule: change.contact_rule, sheet_owner: change.sheet_owner, source_modified_at: change.source_modified_at, os_won: osWon, quote_baseline: q.baseline === true || q.state !== undefined ? true : undefined, quote_state: q.state, quote_value: q.value, quote_at: q.at ?? change.quote_at, ids_filled: x.ids_filled?.length ? x.ids_filled : undefined, quote_meta: x.quote_meta, quote_meta_value: x.quote_meta_value, quote_meta_at: x.quote_meta_at }) };
}
/** Merge new drive_sync metadata over the stored one: a blank sheet cell keeps the stored value instead of erasing it. */
export function mergeDriveSync(prev, patch) {
  const out = { ...(prev && typeof prev === "object" ? prev : {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === "row_hash" || k === "synced_at" || k === "os_won") { if (v !== undefined) out[k] = v; continue; }
    if (v === undefined || v === null || (typeof v === "string" && norm(v) === "")) continue;
    out[k] = v;
  }
  return out;
}
/**
 * OS-won record for a row whose sheet values did not change since the last sync (rehash). Every owned field where OS now holds a
 * different non-empty value was edited in OS, so it is recorded as OS-won; earlier records stay for blank sheet cells. Without
 * this, the rehash's fresh synced_at would let the next unrelated sheet edit overwrite those OS edits with the stale sheet value.
 */
function osWonForUnchangedRow(change, lead, prev, cfg) {
  const owned = change.owned ?? {}; const prevOsWon = prev?.os_won ?? {}; const out = {};
  const current = { quality: lead.quality, next_action: lead.next_action, quality_reason: lead.poor_reason, next_followup_date: cfg.writeNextDate ? lead.next_followup_date : prev?.next_followup_date };
  for (const f of OWNED_FIELDS) {
    const v = norm(owned[f]);
    if (!nonEmpty(v)) { if (prevOsWon[f]) out[f] = prevOsWon[f]; continue; }
    if (f === "quality" && v === "pending") continue;
    const cur = current[f];
    if (nonEmpty(cur) && norm(cur) !== v) out[f] = valueTag(v);
  }
  return out;
}
const valueTag = (v) => sha(`os_won/${norm(v)}`).slice(0, 16); // no sheet text stored, only a tag of it
export const claimTag = (k) => sha(`claim/${k}`).slice(0, 24);
function identityClaimsOf(change) {
  const id = change.identity ?? {};
  const pk = id.phone_digits || phoneDigits(id.phone); const ek = emailKey(id.email);
  return [`key:${claimTag(change.key)}`, ...(id.fingerprint ? [`fp:${id.fingerprint}`] : []), ...(pk ? [`phone:${sha(pk).slice(0, 24)}`] : []), ...(ek ? [`email:${sha(ek).slice(0, 24)}`] : [])];
}
/** Validate the claims a caller carries over from earlier batches of the same run ({ lead id or identity tag: claim tag }). */
export function validateClaims(c) {
  if (c == null) return null;
  if (typeof c !== "object" || Array.isArray(c)) return "bad_claims";
  const e = Object.entries(c);
  if (e.length > 50000) return "too_many_claims";
  for (const [k, v] of e) if (k.length > 200 || typeof v !== "string" || v.length > 64) return "bad_claims";
  return null;
}
/** Number of database writes one decision costs, for the per-run cap. */
export function writeCost(d) {
  if (d.action === "insert") return 3 + (d.notes?.length ?? 0); // lead insert + notes + sync note + hash commit
  if (d.action === "rehash") return 1; // drive_sync commit only
  if (d.action === "update") { // field/unarchive update (only when there is one) + notes + sync note + hash commit
    const fieldUpdate = Object.keys(d.set ?? {}).length > 0 || d.unarchive ? 1 : 0;
    return fieldUpdate + (d.notes?.length ?? 0) + 2;
  }
  return 0;
}

/**
 * Plan a whole batch: decisions + counts. Also used by the route for dry runs. `claims` carries the claimed leads and the
 * reserved new identities of earlier batches of the same run, so a lead matched from two batches is written once.
 */
export function planBatch(changes, leads, cfg, claims = null) {
  const idx = buildIndexes(leads); const claimed = new Map(Object.entries(claims ?? {}));
  const decisions = changes.map((c) => ({ change: c, d: decideChange(c, idx, cfg, claimed) }));
  const counts = { read: changes.length, matched: 0, inserted: 0, would_insert: 0, updated: 0, rehashed: 0, noop: 0, skipped: 0, held: 0, conflicts: 0, writes: 0, ids_leadgen: 0, ids_ads: 0, id_conflicts: 0, quotes_after_link: 0, quotes_not_sendable: 0 };
  for (const { d } of decisions) {
    if (d.ids_gained?.includes("meta_leadgen_id")) counts.ids_leadgen += 1;
    if (d.ids_gained?.some((f) => META_ID_AD_FIELDS.includes(f))) counts.ids_ads += 1;
    counts.id_conflicts += (d.conflicts ?? []).filter((c) => META_ID_FIELDS.includes(c.field)).length;
    if (d.quote_late) counts.quotes_after_link += 1;
    if (String(d.quote_meta_state ?? "").startsWith("not_sendable")) counts.quotes_not_sendable += 1;
    if (d.lead_id) counts.matched += 1;
    if (d.action === "insert") counts.inserted += 1; else if (d.action === "update") counts.updated += 1; else if (d.action === "rehash") counts.rehashed += 1; else if (d.action === "noop") counts.noop += 1; else if (d.action === "skip") counts.skipped += 1; else if (d.action === "hold") { counts.held += 1; if (d.would === "insert") counts.would_insert += 1; }
    counts.conflicts += d.conflicts?.length ?? 0; counts.writes += writeCost(d);
  }
  return { decisions, counts, claims: Object.fromEntries(claimed) };
}
