import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/dashboard/ads-roi
 *
 * Returns ad ROI data for CEO/Admin view.
 * Query params: none (uses all available ad_spend data)
 */
export async function GET() {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check role — only boss/admin can see ad ROI
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile || !["boss", "admin"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ─── 1. Ad spend totals ───
    const { data: adSpend, error: adErr } = await supabase
      .from("ad_spend")
      .select("campaign_name, amount");

    if (adErr) throw adErr;

    const totalSpend = (adSpend || []).reduce(
      (sum, row) => sum + (parseFloat(row.amount) || 0),
      0
    );

    // Spend per campaign
    const spendByCampaign: Record<string, number> = {};
    for (const row of adSpend || []) {
      const campaign = row.campaign_name || "Uncategorized";
      spendByCampaign[campaign] =
        (spendByCampaign[campaign] || 0) + (parseFloat(row.amount) || 0);
    }

    // ─── 2. Leads from meta ───
    const { data: metaLeads, error: leadsErr } = await supabase
      .from("leads")
      .select("id, campaign_name, stage, quotation_value, ai_quality, source, final_status")
      .eq("source", "meta_ads")
      .eq("archived", false);

    if (leadsErr) throw leadsErr;

    const totalMetaLeads = metaLeads?.length || 0;

    // Leads per campaign
    const leadsByCampaign: Record<string, number> = {};
    const conversionsByCampaign: Record<string, number> = {};
    const signedAmountByCampaign: Record<string, number> = {};

    for (const lead of metaLeads || []) {
      const campaign = lead.campaign_name || "Uncategorized";
      leadsByCampaign[campaign] = (leadsByCampaign[campaign] || 0) + 1;
      if (lead.final_status === "won") {
        conversionsByCampaign[campaign] =
          (conversionsByCampaign[campaign] || 0) + 1;
        signedAmountByCampaign[campaign] =
          (signedAmountByCampaign[campaign] || 0) +
          (parseFloat(String(lead.quotation_value || "")) || 0);
      }
    }

    const totalConversions = metaLeads?.filter((l) => l.final_status === "won").length || 0;
    const totalSignedAmount = (metaLeads || [])
      .filter((l) => l.final_status === "won")
      .reduce((sum, l) => sum + (parseFloat(String(l.quotation_value || "")) || 0), 0);

    // ─── 3. Campaign breakdown ───
    const allCampaigns = new Set([
      ...Object.keys(spendByCampaign),
      ...Object.keys(leadsByCampaign),
    ]);

    const campaignBreakdown = Array.from(allCampaigns)
      .map((campaign) => {
        const spend = spendByCampaign[campaign] || 0;
        const leads = leadsByCampaign[campaign] || 0;
        const conversions = conversionsByCampaign[campaign] || 0;
        const signedAmount = signedAmountByCampaign[campaign] || 0;
        const cpl = leads > 0 ? Math.round((spend / leads) * 100) / 100 : 0;
        const roas = spend > 0 ? Math.round((signedAmount / spend) * 100) / 100 : 0;
        return {
          campaign,
          spend: Math.round(spend * 100) / 100,
          leads,
          cpl,
          conversions,
          signed_amount: Math.round(signedAmount * 100) / 100,
          roas,
        };
      })
      .sort((a, b) => b.spend - a.spend);

    // ─── 4. Source vs Quality ───
    const { data: allLeads, error: allLeadsErr } = await supabase
      .from("leads")
      .select("source, ai_quality, stage, final_status")
      .eq("archived", false);

    if (allLeadsErr) throw allLeadsErr;

    const sourceQuality: Record<
      string,
      { total: number; good: number; pending: number; bad: number; won: number }
    > = {};

    for (const lead of allLeads || []) {
      const source = lead.source || "unknown";
      if (!sourceQuality[source]) {
        sourceQuality[source] = { total: 0, good: 0, pending: 0, bad: 0, won: 0 };
      }
      sourceQuality[source].total++;
      const quality = (lead.ai_quality || "pending").toLowerCase();
      if (quality === "good" || quality === "hot") {
        sourceQuality[source].good++;
      } else if (quality === "bad" || quality === "cold") {
        sourceQuality[source].bad++;
      } else {
        sourceQuality[source].pending++;
      }
      if (lead.final_status === "won") {
        sourceQuality[source].won++;
      }
    }

    const sourceQualityBreakdown = Object.entries(sourceQuality)
      .map(([source, data]) => ({
        source,
        total: data.total,
        good: data.good,
        pending: data.pending,
        bad: data.bad,
        conv_rate:
          data.total > 0
            ? Math.round((data.won / data.total) * 10000) / 100
            : 0,
      }))
      .sort((a, b) => b.total - a.total);

    // ─── 5. Period indicator ───
    const { data: dateRange, error: dateErr } = await supabase
      .from("ad_spend")
      .select("spend_date")
      .order("spend_date", { ascending: true })
      .limit(1);

    const { data: dateRangeEnd, error: dateEndErr } = await supabase
      .from("ad_spend")
      .select("spend_date")
      .order("spend_date", { ascending: false })
      .limit(1);

    const startDate =
      dateRange && dateRange.length > 0 ? dateRange[0].spend_date : null;
    const endDate =
      dateRangeEnd && dateRangeEnd.length > 0
        ? dateRangeEnd[0].spend_date
        : null;

    const overall_cpl =
      totalMetaLeads > 0
        ? Math.round((totalSpend / totalMetaLeads) * 100) / 100
        : 0;
    const overall_roas =
      totalSpend > 0
        ? Math.round((totalSignedAmount / totalSpend) * 100) / 100
        : 0;

    return NextResponse.json({
      period: {
        start_date: startDate,
        end_date: endDate,
      },
      summary: {
        total_spend: Math.round(totalSpend * 100) / 100,
        total_leads: totalMetaLeads,
        cpl: overall_cpl,
        conversions: totalConversions,
        signed_amount: Math.round(totalSignedAmount * 100) / 100,
        roas: overall_roas,
      },
      campaign_breakdown: campaignBreakdown,
      source_quality: sourceQualityBreakdown,
    });
  } catch (err: unknown) {
    console.error("[Ads ROI] Error:", err);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message || "Failed to fetch ad ROI data" },
      { status: 500 }
    );
  }
}
