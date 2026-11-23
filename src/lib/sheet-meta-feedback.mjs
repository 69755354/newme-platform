// Daily feedback of the sales sheet's quality / quote outcome to Meta, for the matching OS lead.
// Reads nothing but plain values: this module never touches the sheet and never writes OS lead stage/quality/owner.
// It only enqueues Meta events, with the SAME event names, queue tables and dedupe rules as the OS stage-change paths:
//   form leads (leadgen id): meta_crm_stage_events  Qualified (requirement_confirmed), Quoted (quotation_submitted), Lost (lost)
//   click-to-WhatsApp leads: whatsapp_capi_events QualifiedLead, and the valued InitiateCheckout (quote) via the outbox
// WhatsApp has no lost/disqualified event, so a "Not fit" WhatsApp lead sends nothing.
import { leadRef } from "./meta-ids-export.mjs";
import { moneyNumber } from "./drive-sync.mjs";
import { normalizeCtwaClid } from "./whatsapp-ctwa.mjs";
import { deterministicUuid } from "./capi-hash.mjs";
import { META_CRM_STAGE_EVENTS, enqueueMetaCrmStageEvent, normalizeLeadgenId } from "./meta-crm-events.ts";
import { enqueueWhatsAppCapiEvent, enqueueWhatsAppQuoteForLead } from "./whatsapp-capi.mjs";

export const FORM_STAGE = Object.freeze({ qualified: "requirement_confirmed", quoted: "quotation_submitted", lost: "lost" });
export const FORM_EVENT = Object.freeze({
  qualified: META_CRM_STAGE_EVENTS[FORM_STAGE.qualified], quoted: META_CRM_STAGE_EVENTS[FORM_STAGE.quoted], lost: META_CRM_STAGE_EVENTS[FORM_STAGE.lost],
});
export const WA_QUALIFIED = "QualifiedLead";
export const WA_QUOTE_EVENT_PREFIX = "wa-quote:"; // event id used by enqueueWhatsAppQuoteForLead

const QUALIFIED = new Set(["qualified", "good"]);
const NOT_FIT = new Set(["not fit", "poor", "low", "invalid", "fake", "job seeker", "junk", "spam"]);
const norm = (v) => String(v ?? "").trim();
const lc = (v) => norm(v).toLowerCase().replace(/\s+/g, " ");

export const DEFAULT_MAX_EVENTS = 100;
export const DEFAULT_MAX_LEAD_AGE_DAYS = 28;

/** Header-name lookup (the sheet is edited by people, so no fixed column letters). */
export function parseRegister(values) {
  const header = (values[0] ?? []).map(norm);
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const idx = { quality: col("Lead quality"), quote: col("Quote value AED"), master: col("Master Lead ID"), source: col("Source lead ID"), stage: col("Opportunity stage") };
  // Sales write Day 1-5 feedback (R-V) and "Later follow-ups / B2B notes" (W); optional columns, found by name.
  const fbCols = [1, 2, 3, 4, 5].map((n) => col(`Day ${n} feedback`)).concat(col("Later follow-ups / B2B notes")).filter((i) => i >= 0);
  const missing = Object.entries(idx).filter(([k, v]) => v < 0 && k !== "stage").map(([k]) => k);
  if (missing.length) throw new Error(`Lead Register header lacks: ${missing.join(", ")}`);
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const r = values[i] ?? [];
    const master = norm(r[idx.master]); const source = norm(r[idx.source]);
    if (!master && !source) continue;
    rows.push({ master, source, quality: lc(r[idx.quality]), quoteRaw: norm(r[idx.quote]), feedback: fbCols.map((i) => norm(r[i])).filter(Boolean).join("\n") });
  }
  return rows;
}

const IMPORTED_BLOCK = /\[Imported source notes[\s\S]*?(?=\n\s*\n|$)/gi;
// A segment (sentence / line) that shows the customer is not a prospect or could not be reached never qualifies.
const NEGATIVE = /not interested|no (in)?quiry|no enquiry|junk|wrong number|budget|no answer|not answer|no response|not respond|unreachable|not reachable|spam|fake|not looking|no need|not need|doesn'?t need|don'?t need|in a meeting|call (me )?back|cancel/i;
// A negated next step ("no meeting", "refused quotation") is not a next step either.
const NEGATED_STEP = /\b(no|not|without|never|refus\w*|declin\w*|rejected?)\s+(\w+\s+)?(drawings?|quot\w*|meeting|visit\w*|showroom)/i;
const POSITIVE = /\bdrawings?\b|\bquot(e|es|ed|ing|ation|ations)\b|\bsite visit|\bvisit(ed|ing)?\s+(his|her|their|the|our|my)?\s*(site|villa|home|house|apartment|showroom|property)|\bshow ?room( visit)?\b|\bmeeting\b|\bmeet(ing)? (him|her|them|at|on)\b/i;

/**
 * Sales free text -> does it show a genuine next step (drawings, quotation, site visit, meeting, showroom visit)?
 * The "[Imported source notes ...]" block is history, not sales feedback, and is ignored. Pure.
 */
export function feedbackShowsNextStep(text) {
  const clean = String(text ?? "").replace(IMPORTED_BLOCK, " ");
  return clean.split(/[\n.;!?]+/).some((seg) => POSITIVE.test(seg) && !NEGATIVE.test(seg) && !NEGATED_STEP.test(seg));
}

/**
 * One sheet row -> what it says (never the customer). `rules` lists why it qualifies: quality, quote, feedback.
 * An explicit "Not fit" is not overridden by feedback text, only by a quote amount.
 */
export function classifyRow(row) {
  const quote = moneyNumber(row.quoteRaw);
  const rules = [];
  if (QUALIFIED.has(row.quality)) rules.push("quality");
  if (quote !== null) rules.push("quote");
  const notFit = NOT_FIT.has(row.quality);
  if (!notFit && feedbackShowsNextStep(row.feedback)) rules.push("feedback");
  const outcome = rules.length ? "qualified" : notFit ? "not_fit" : "none";
  return { outcome, rules, quote, badQuote: row.quoteRaw !== "" && quote === null && !/^0*(\.0+)?$/.test(row.quoteRaw.replace(/[,\s]/g, "")) };
}

/** Lead index from OS rows {id, meta_leadgen_id, ctwa_clid, created_at, archived}. */
export function buildLeadIndex(leads) {
  const byId = new Map(); const byRef = new Map(); const byLeadgen = new Map(); const byClid = new Map();
  for (const l of leads) {
    byId.set(String(l.id).toLowerCase(), l); byRef.set(leadRef(l.id), l);
    const g = normalizeLeadgenId(l.meta_leadgen_id); if (g) byLeadgen.set(g, l);
    const c = normalizeCtwaClid(l.ctwa_clid); if (c) byClid.set(c, l);
  }
  return { byId, byRef, byLeadgen, byClid };
}

export function matchLead(row, index) {
  const master = row.master;
  // Master ids seen in the register: WA-NM-<12 hex> (public lead ref), WA-<lead uuid>, META-<leadgen id>.
  let m = /^WA-(NM-[0-9a-f]{12})$/i.exec(master);
  const ref = m ? `NM-${m[1].slice(3).toLowerCase()}` : null;
  if (ref && index.byRef.has(ref)) return index.byRef.get(ref);
  m = /^WA-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(master);
  if (m && index.byId.has(m[1].toLowerCase())) return index.byId.get(m[1].toLowerCase());
  // The source cell can hold several ids on separate lines ("l:<leadgen id>" and "ctwa:<click id>").
  const tokens = [/^META-(\d{8,32})$/i.exec(master)?.[1], ...row.source.split(/[\s,;]+/).filter(Boolean)];
  for (const t of tokens) {
    if (!t) continue;
    const lg = normalizeLeadgenId(/^l:/i.test(t) || /^\d+$/.test(t) ? t : null);
    if (lg && index.byLeadgen.has(lg)) return index.byLeadgen.get(lg);
    const clid = /^ctwa:/i.test(t) ? normalizeCtwaClid(t.slice(5)) : null;
    if (clid && index.byClid.has(clid)) return index.byClid.get(clid);
  }
  return null;
}

/**
 * Pure plan. `existing` = { form: Set("leadId|EventName"), wa: Set("leadId|EventName"), waQuote: Set(leadId) }
 * `waba` = Set of lead ids whose click-to-WhatsApp conversation has a valid business account id.
 */
export function planFeedback(rows, index, { existing, waba, nowMs, maxEvents = DEFAULT_MAX_EVENTS, maxLeadAgeDays = DEFAULT_MAX_LEAD_AGE_DAYS, sendLost = true }) {
  const counts = { sheet_rows: rows.length, qualified_rows: 0, rows_by_quality: 0, rows_by_quote: 0, rows_by_feedback: 0, leads_by_quality: 0, leads_by_quote: 0, leads_by_feedback: 0, leads_only_by_quality: 0, leads_only_by_quote: 0, leads_only_by_feedback: 0, not_fit_rows: 0, quote_rows: 0, bad_quote_cells: 0, unmatched: 0, unmatched_legacy: 0, archived: 0,
    too_old: 0, already_queued: 0, not_fit_wa_no_signal: 0, no_ctwa_clid_or_leadgen: 0, wa_no_waba: 0, lost_disabled: 0, deferred_by_cap: 0, duplicate_rows: 0,
    form_qualified: 0, form_quoted: 0, form_lost: 0, wa_qualified: 0, wa_quote_valued: 0, form_quoted_os_value_known: 0 };
  const items = []; const seen = new Set(); let total = 0;
  const maxAgeMs = maxLeadAgeDays * 86_400_000;
  for (const row of rows) {
    const c = classifyRow(row);
    if (c.outcome === "qualified") counts.qualified_rows++;
    for (const r of c.rules) counts[`rows_by_${r}`]++;
    if (c.outcome === "not_fit") counts.not_fit_rows++;
    if (c.quote) counts.quote_rows++;
    if (c.badQuote) counts.bad_quote_cells++;
    if (c.outcome === "none" && !c.quote) continue;
    const lead = matchLead(row, index);
    if (!lead) { counts.unmatched++; if (/^LEGACY-/i.test(row.master)) counts.unmatched_legacy++; continue; }
    if (seen.has(lead.id)) { counts.duplicate_rows++; continue; }
    seen.add(lead.id);
    if (lead.archived) { counts.archived++; continue; }
    const created = Date.parse(lead.created_at ?? "");
    if (!Number.isFinite(created) || nowMs - created > maxAgeMs) { counts.too_old++; continue; }
    const qualified = c.outcome === "qualified";
    if (qualified) { for (const r of c.rules) counts[`leads_by_${r}`]++; if (c.rules.length === 1) counts[`leads_only_by_${c.rules[0]}`]++; }
    const events = [];
    const isForm = Boolean(normalizeLeadgenId(lead.meta_leadgen_id));
    const isWa = Boolean(normalizeCtwaClid(lead.ctwa_clid)) && waba.has(lead.id);
    if (!isForm && !isWa) {
      // WhatsApp lead without a click id (organic or imported) cannot be reported; one with a click id but no business account id likewise.
      if (normalizeCtwaClid(lead.ctwa_clid)) counts.wa_no_waba++; else counts.no_ctwa_clid_or_leadgen++;
      continue;
    }
    if (isForm) {
      const has = (name) => existing.form.has(`${lead.id}|${name}`);
      if (qualified) {
        if (!has(FORM_EVENT.qualified)) events.push({ kind: "form_qualified", stage: FORM_STAGE.qualified }); else counts.already_queued++;
        if (c.quote !== null) { if (!has(FORM_EVENT.quoted)) events.push({ kind: "form_quoted", stage: FORM_STAGE.quoted, value: c.quote, osValue: Number(lead.quotation_value) > 0 }); else counts.already_queued++; }
      } else if (c.outcome === "not_fit") {
        if (!sendLost) counts.lost_disabled++;
        else if (has(FORM_EVENT.lost)) counts.already_queued++;
        else if (!has(FORM_EVENT.qualified)) events.push({ kind: "form_lost", stage: FORM_STAGE.lost });
      }
    }
    if (isWa) {
      if (qualified) {
        if (!existing.wa.has(`${lead.id}|${WA_QUALIFIED}`)) events.push({ kind: "wa_qualified" }); else counts.already_queued++;
        if (c.quote !== null) { if (!existing.waQuote.has(lead.id)) events.push({ kind: "wa_quote_valued", value: c.quote }); else counts.already_queued++; }
      } else if (c.outcome === "not_fit") counts.not_fit_wa_no_signal++;
    }
    if (!events.length) continue;
    if (total + events.length > maxEvents) { counts.deferred_by_cap++; continue; }
    total += events.length;
    for (const e of events) { counts[e.kind]++; if (e.kind === "form_quoted" && e.osValue) counts.form_quoted_os_value_known++; }
    items.push({ leadId: lead.id, leadgen: lead.meta_leadgen_id ?? null, events });
  }
  return { items, counts, total };
}

/** Apply a plan with the existing enqueue helpers (each is idempotent per lead + event and never throws). */
export async function applyPlan(db, items, { nowSeconds = Math.floor(Date.now() / 1000), waQuoteAttempt = null } = {}) {
  const out = { queued: 0, skipped: 0 };
  const tally = (r) => { if (r === "queued") out.queued++; else out.skipped++; };
  for (const item of items) {
    for (const e of item.events) {
      // Earlier funnel steps get an earlier time so Meta sees them in order.
      if (e.kind === "form_qualified") tally(await enqueueMetaCrmStageEvent(db, { id: item.leadId, meta_leadgen_id: item.leadgen }, e.stage, nowSeconds - 1));
      else if (e.kind === "form_quoted" || e.kind === "form_lost") tally(await enqueueMetaCrmStageEvent(db, { id: item.leadId, meta_leadgen_id: item.leadgen }, e.stage, nowSeconds));
      else if (e.kind === "wa_qualified") tally(await enqueueWhatsAppCapiEvent(db, item.leadId, WA_QUALIFIED, { nowSeconds: nowSeconds - 1 }));
      else if (e.kind === "wa_quote_valued") tally(await enqueueWhatsAppQuoteForLead(db, item.leadId, { amount: { value: e.value, currency: "AED" }, nowSeconds, attempt: waQuoteAttempt }));
    }
  }
  return out;
}

export const waQuoteOutboxId = (leadId) => deterministicUuid(`${WA_QUOTE_EVENT_PREFIX}${leadId}`);
