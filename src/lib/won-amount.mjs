// A lead can only be marked won with an amount (Sam's rule, S36 B10). The amount is, in this order:
//   1. the active (or completed) contract's amount;
//   2. the latest live (not rejected / expired) quotation's total, else the lead's stored quotation_value;
//   3. an amount typed at that moment (stored in leads.quotation_value before the lead is won, so the contract the
//      "lead won" trigger creates, the KPIs and the Won / Purchase events to Meta all carry the same number).
// An amount that already exists is never replaced by a typed one.
import { activeContractAmount } from "./whatsapp-capi.mjs";
import { latestQuotationAmount } from "./quote-amount.mjs";

// leads.quotation_value is numeric(12,2).
export const MAX_WON_AMOUNT = 9_999_999_999;

/** The amount a won lead reports to Meta and the KPIs, or null when there is none. */
export async function wonAmountForLead(db, leadId) {
  return (await activeContractAmount(db, leadId)) ?? (await latestQuotationAmount(db, leadId));
}

/** A positive amount with at most two decimals that fits the column, from a number or a typed string; else null. */
export function parseEnteredAmount(raw) {
  let value = null;
  if (typeof raw === "number") value = raw;
  else if (typeof raw === "string" && raw.trim() !== "") value = Number(raw.replace(/,/g, "").trim());
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 && rounded <= MAX_WON_AMOUNT ? rounded : null;
}

export const WON_AMOUNT_REQUIRED = Object.freeze({
  code: "won_amount_required",
  error: "An amount is required to mark a deal won: add a quotation or enter the deal amount.",
  error_zh: "赢单必须有金额：请先报价，或填写成交金额。",
});

/**
 * Makes sure the lead has an amount before it is won. Returns { ok: true, amount, wrote } (wrote = a typed amount was
 * stored) or { ok: false, code, error, error_zh }. `db` must be the service-role client.
 */
export async function ensureWonAmount(db, leadId, enteredAmount) {
  const known = await wonAmountForLead(db, leadId);
  if (known) return { ok: true, amount: known, wrote: false };
  const typed = parseEnteredAmount(enteredAmount);
  if (typed === null) return { ok: false, ...WON_AMOUNT_REQUIRED };
  const { error } = await db.from("leads").update({ quotation_value: typed }).eq("id", leadId);
  if (error) {
    return { ok: false, code: "won_amount_save_failed", error: "The deal amount could not be saved; nothing was changed.", error_zh: "成交金额没能保存，线索没有改动。" };
  }
  return { ok: true, amount: { value: typed, currency: "AED" }, wrote: true };
}

/**
 * Takes a typed amount back out after a failed won transition, but only if it is still safe: one conditional UPDATE that
 * matches the row only while it still holds exactly the value this request wrote AND the lead is not won. If a concurrent
 * request already won the lead with that amount, or a quotation trigger stored a newer value, nothing is touched.
 * (The amount cannot ride in transition_lead_stage without a SQL change, so the pre-write stays; see FOLLOWUPS.)
 * Best effort: never throws. `db` must be the service-role client.
 */
export async function revertWonAmount(db, leadId, written, previous) {
  try {
    const { error } = await db.from("leads").update({ quotation_value: previous ?? null })
      .eq("id", leadId)
      .eq("quotation_value", written)
      .neq("stage", "won")
      .or("final_status.is.null,final_status.neq.won");
    return !error;
  } catch {
    return false;
  }
}
