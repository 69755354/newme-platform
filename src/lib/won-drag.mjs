// Dragging a lead onto Won on the boards goes through the same server route as the lead page ("Won" button):
// PATCH /api/leads/:id/stage, which requires an amount (contract, quotation or the one typed), writes the stage through
// the audited routine and queues the Won / Purchase events. This builds that request and reads the answer, so the
// boards never write final_status from the browser.

/** The amount field is shown when the lead has no amount yet, or after the server asked for one. */
export const leadHasWonAmount = (lead) => Number(lead?.quotation_value) > 0;

/**
 * Sends the Won request. `fetchImpl` is fetch. Returns { ok: true, lead } or
 * { ok: false, needsAmount, error, error_zh } (needsAmount = the server wants an amount typed).
 */
export async function submitWonFromDrag(fetchImpl, leadId, { note, amount, idempotencyKey }) {
  const trimmedAmount = typeof amount === "string" ? amount.trim() : "";
  let response;
  try {
    response = await fetchImpl(`/api/leads/${encodeURIComponent(leadId)}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "won", note: String(note ?? "").trim(), idempotencyKey, ...(trimmedAmount ? { amount: trimmedAmount } : {}) }),
    });
  } catch {
    return { ok: false, needsAmount: false, error: "Network error; the lead was not changed.", error_zh: "网络出错，线索没有改动。" };
  }
  let body = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (response.ok && body && body.success !== false) return { ok: true, lead: body.lead ?? null };
  return {
    ok: false,
    needsAmount: body?.code === "won_amount_required",
    error: typeof body?.error === "string" ? body.error : "Could not mark the lead won.",
    error_zh: typeof body?.error_zh === "string" ? body.error_zh : (typeof body?.error === "string" ? body.error : "没能标记赢单。"),
  };
}
