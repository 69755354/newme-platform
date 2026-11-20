// The amount a lead was quoted: the newest quotation that is not rejected or expired.
// Shared by every Meta feedback path (form leads, WhatsApp, website) so they report one number.
export async function latestQuotationAmount(db, leadId) {
  const { data, error } = await db.from("quotations").select("total_amount, currency, created_at")
    .eq("lead_id", leadId).not("status", "in", "(rejected,expired)").order("created_at", { ascending: false }).limit(1);
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) return null;
  const value = Number(row.total_amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, currency: typeof row.currency === "string" && /^[A-Za-z]{3}$/.test(row.currency) ? row.currency.toUpperCase() : "AED" };
}
