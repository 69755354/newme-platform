// The amount a lead was quoted, for every Meta feedback path (form leads, WhatsApp, website), so they report one number:
// the newest AED quotation with a positive total that is not rejected or expired (the same rule as the database trigger
// that keeps leads.quotation_value, so KPIs, Meta and the won amount agree); if none exists, leads.quotation_value
// (the sales-reported amount the Drive sheet sync stores, AED). A quotation in another currency is never read as AED.
export async function latestQuotationAmount(db, leadId) {
  const { data, error } = await db.from("quotations").select("total_amount, currency, created_at")
    .eq("lead_id", leadId).not("status", "in", "(rejected,expired)").order("created_at", { ascending: false }).limit(20);
  if (!error && Array.isArray(data)) {
    for (const row of data) {
      const currency = row?.currency == null ? "AED" : String(row.currency).trim().toUpperCase();
      const value = Number(row?.total_amount);
      if (currency === "AED" && Number.isFinite(value) && value > 0) return { value, currency: "AED" };
    }
  }
  const lead = await db.from("leads").select("quotation_value").eq("id", leadId).maybeSingle();
  const reported = Number(lead?.data?.quotation_value);
  return !lead?.error && Number.isFinite(reported) && reported > 0 ? { value: reported, currency: "AED" } : null;
}
