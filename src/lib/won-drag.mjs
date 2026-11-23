// Dragging a lead onto Won on the boards goes through the same server route as the lead page ("Won" button):
// PATCH /api/leads/:id/stage, which requires an amount (contract, quotation or the one typed), writes the stage through
// the audited routine and queues the Won / Purchase events. This builds that request and reads the answer, so the
// boards never write final_status from the browser.

/** The amount field is shown when the lead has no amount yet, or after the server asked for one. */
export const leadHasWonAmount = (lead) => Number(lead?.quotation_value) > 0;

/** A dragged lead is closed (won or lost) only through the server route; lost needs a reason, which is the note. */
export const DRAG_CLOSE_STAGES = Object.freeze(["won", "lost"]);

/** The browser cannot tell whether a request that failed on the network was applied: the message says to refresh and check. */
const NETWORK_UNCERTAIN = {
  error: "Network error; the change may or may not have been saved. Refresh the page to confirm.",
  error_zh: "网络出错，请刷新确认是否已保存。",
};

/**
 * Sends the Won request. `fetchImpl` is fetch. Returns { ok: true, lead } or
 * { ok: false, needsAmount, error, error_zh } (needsAmount = the server wants an amount typed).
 */
export async function submitWonFromDrag(fetchImpl, leadId, { note, amount, idempotencyKey }) {
  return submitStageFromDrag(fetchImpl, leadId, { stage: "won", note, amount, idempotencyKey });
}

/** Won (note + amount) or lost (reason as the note) through PATCH /api/leads/:id/stage. The same key may be resent on a retry. */
export async function submitStageFromDrag(fetchImpl, leadId, { stage, note, amount, idempotencyKey }) {
  if (!DRAG_CLOSE_STAGES.includes(stage)) throw new Error("submitStageFromDrag closes a lead as won or lost only");
  const trimmedAmount = typeof amount === "string" ? amount.trim() : "";
  let response;
  try {
    response = await fetchImpl(`/api/leads/${encodeURIComponent(leadId)}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, note: String(note ?? "").trim(), idempotencyKey, ...(stage === "won" && trimmedAmount ? { amount: trimmedAmount } : {}) }),
    });
  } catch {
    return { ok: false, needsAmount: false, ...NETWORK_UNCERTAIN };
  }
  let body = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (response.ok && body && body.success !== false) return { ok: true, lead: body.lead ?? null };
  return {
    ok: false,
    needsAmount: body?.code === "won_amount_required",
    reasons: Array.isArray(body?.reasons) ? body.reasons.map(String) : [],
    reasons_zh: Array.isArray(body?.reasons_zh) ? body.reasons_zh.map(String) : [],
    error: typeof body?.error === "string" ? body.error : (stage === "won" ? "Could not mark the lead won." : "Could not mark the lead lost."),
    error_zh: typeof body?.error_zh === "string" ? body.error_zh : (stage === "won" ? "没能标记赢单。" : "没能标记丢单。"),
  };
}
