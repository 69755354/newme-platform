// Decision core for "the sales sheet says this lead was quoted, with an amount" (no admin confirmation: the sheet is
// written by people and is the source of truth). Pure; the Drive sync applies the verdict. Not wired yet: the sheets'
// quote columns are not in the sync's column mapping (see fixes/PURCHASE-CAPI-20261120.md).
export const SHEET_QUOTE_MAX_AGE_SECONDS = 7 * 86_400;
const STAGE_ORDER = ["new", "contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision"];
const isFinal = (lead) => ["won", "lost"].includes(lead?.final_status) || ["won", "lost"].includes(lead?.stage);

/**
 * @param lead {stage, final_status, archived}  OS lead
 * @param sheet {amount, currency?, quotedAtIso?}  parsed from the row (amount already a number)
 * @param firstSeenIso  when the sync first saw the quote in the sheet (used when the sheet has no quote date)
 * @returns {{action: "queue"|"skip", reason?: string, advanceStage?: boolean, eventTime?: number, value?: number, currency?: string}}
 */
export function planSheetQuote({ lead, sheet, firstSeenIso, nowMs }) {
  if (!lead || lead.archived) return { action: "skip", reason: "archived_or_missing" };
  if (isFinal(lead)) return { action: "skip", reason: "os_final" }; // never touch OS-final leads
  const value = Number(sheet?.amount);
  if (!Number.isFinite(value) || value <= 0) return { action: "skip", reason: "no_amount" };
  const currency = typeof sheet.currency === "string" && /^[A-Za-z]{3}$/.test(sheet.currency) ? sheet.currency.toUpperCase() : "AED";
  const at = Date.parse(sheet.quotedAtIso || firstSeenIso || "");
  if (!Number.isFinite(at)) return { action: "skip", reason: "no_date" };
  const eventTime = Math.floor(at / 1000);
  const ageSeconds = Math.floor(nowMs / 1000) - eventTime;
  if (ageSeconds < 0) return { action: "skip", reason: "future_date" };
  // A quote older than 7 days cannot be sent (Meta window); found at the first sync it is history, not a signal.
  if (ageSeconds > SHEET_QUOTE_MAX_AGE_SECONDS) return { action: "skip", reason: "stale" };
  const idx = STAGE_ORDER.indexOf(lead.stage);
  // Forward only: a lead already at or past the quotation stage is never moved back; unknown stages are left alone.
  const advanceStage = idx >= 0 && idx < STAGE_ORDER.indexOf("quotation_submitted");
  return { action: "queue", advanceStage, eventTime, value, currency };
}

/**
 * Whether the sheet's "quotation reported" should also move the OS stage forward (S33): the lead is live (not archived, not
 * won/lost) and sits on the funnel strictly before quotation_submitted. Forward only; the database routine
 * sync_advance_lead_stage_from_sheet repeats every one of these checks and walks the audited steps.
 */
export function shouldAdvanceStageForQuote(lead) {
  if (!lead || lead.archived || isFinal(lead)) return false;
  const idx = STAGE_ORDER.indexOf(lead.stage);
  return idx >= 0 && idx < STAGE_ORDER.indexOf("quotation_submitted");
}
