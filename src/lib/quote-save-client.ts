// Every quotation made in the browser is saved through the server route, so it gets the same side effects as one made
// anywhere else: activity and timeline entries, the stage step, the lead's amount (quotation_value) and the Meta /
// WhatsApp quote feedback. The screens never write the quotations table themselves.

export type QuoteSaveResult =
  | { ok: true; quoteId: string; quoteNo: string; total: number; currency: string; validUntil: string | null }
  | { ok: false; message: string };

/** `body` is the POST /api/quotations/generate body: { lead_id, devices, discount_rate?, notes? } or { lead_id, manual, notes? }. */
export async function saveQuoteViaServer(body: Record<string, unknown>, lang: string): Promise<QuoteSaveResult> {
  const fallback = lang === "zh" ? "报价保存失败，请重试" : "Could not save the quotation, please retry";
  try {
    const response = await fetch("/api/quotations/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json?.quote_id || !json?.quote_no) {
      const message = (lang === "zh" ? json?.error_zh : undefined) || json?.error || fallback;
      return { ok: false, message: typeof message === "string" ? message : fallback };
    }
    return {
      ok: true,
      quoteId: String(json.quote_id),
      quoteNo: String(json.quote_no),
      total: Number(json.total) || 0,
      currency: typeof json.currency === "string" ? json.currency : "AED",
      validUntil: typeof json.valid_until === "string" ? json.valid_until : null,
    };
  } catch {
    return { ok: false, message: fallback };
  }
}
