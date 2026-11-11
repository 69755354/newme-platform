// S16 (S15 observation 3): the quotation route answers { stage_advanced, lead_stage,
// stage_advance_reason }. When the quotation was saved but the lead stage did not move,
// the page should say why, the same way the milestone page does (leadFlow.stageHint).
//
// This returns the message key for a response body, or null when there is nothing to
// say (the stage moved, the lead was already past quotation, or the reason is not one a
// person can act on). The wording lives in src/lib/i18n/translations.ts under
// leadFlow.quoteStageHint in both languages; tests/unit/s16-quote-stage-hint.test.mjs
// keeps the set of reasons and the two message sets identical.

export const QUOTE_STAGE_HINT_REASONS = Object.freeze([
  "next_followup_required",
  "first_contact_gate",
  "not_permitted",
  "changed_concurrently",
  "stage_update_failed",
  "stage_read_failed",
]);

/** @param {unknown} body the JSON body of POST /api/quotations/generate */
export function quoteStageHintKey(body) {
  if (!body || typeof body !== "object") return null;
  const { stage_advanced: advanced, stage_advance_reason: reason } = /** @type {Record<string, unknown>} */ (body);
  if (advanced !== false) return null;
  return typeof reason === "string" && QUOTE_STAGE_HINT_REASONS.includes(reason)
    ? `leadFlow.quoteStageHint.${reason}`
    : null;
}
