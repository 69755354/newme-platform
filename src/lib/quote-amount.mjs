// The amount a lead was quoted, for every Meta feedback path (form leads, WhatsApp, website), so they report one number:
// the newest quotation that is not rejected or expired; if none exists, leads.quotation_value (the sales-reported
// amount the Drive sheet sync stores, AED).
export async function latestQuotationAmount(db, leadId) {
  const { data, error } = await db.from("quotations").select("total_amount, currency, created_at")
    .eq("lead_id", leadId).not("status", "in", "(rejected,expired)").order("created_at", { ascending: false }).limit(1);
  const row = Array.isArray(data) ? data[0] : null;
  if (!error && row) {
    const value = Number(row.total_amount);
    if (Number.isFinite(value) && value > 0) {
      return { value, currency: typeof row.currency === "string" && /^[A-Za-z]{3}$/.test(row.currency) ? row.currency.toUpperCase() : "AED" };
    }
  }
  const lead = await db.from("leads").select("quotation_value").eq("id", leadId).maybeSingle();
  const reported = Number(lead?.data?.quotation_value);
  return !lead?.error && Number.isFinite(reported) && reported > 0 ? { value: reported, currency: "AED" } : null;
}
