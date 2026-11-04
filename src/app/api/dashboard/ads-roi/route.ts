// RBAC: user (boss, admin)
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import { isWonLead, sourceQualityBreakdown, wonLeadValue, type MetricLead } from "@/lib/lead-metrics.mjs";

function numericAmount(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCampaign(name: string | null): string {
  if (!name) return "Uncategorized";
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * GET /api/dashboard/ads-roi
 *
 * Returns ad ROI data for CEO/Admin view.
 * Query params: none (uses all available ad_spend data)
 */
export async function GET(request: Request) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
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

    if (!profile?.role || !["boss", "admin"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ─── 1. Ad spend totals ───
    // Every ad_spend row is summed, with no filter on `source`. That is correct
    // only because no spend_date is described by two sources at once: both writers
    // refuse a window that another source already covers
    // (src/app/api/meta/ads-sync/route.ts -> overlapping_spend_window,
    //  src/app/api/dashboard/ads-roi/import/route.ts -> api_sourced_days_would_be_double_counted),
    // and tests/security/meta-ads-sync-contract.test.mjs fails if either fence is
    // removed. Filtering to one source here instead would be worse: it would hide
    // the Excel history rather than total the advertising.
    const { data: adSpend, error: adErr } = await supabase
      .from("ad_spend")
      .select("campaign_name, amount");

    if (adErr) throw adErr;

    const knownSpend = (adSpend || [])
      .map((row) => numericAmount(row.amount))
      .filter((amount): amount is number => amount !== null);
    const totalSpend = knownSpend.length > 0
      ? knownSpend.reduce((sum, amount) => sum + amount, 0)
      : null;

    // Spend per campaign (normalized keys)
    const spendByCampaign: Record<string, number> = {};
    const displayNameMap: Record<string, string> = {};
    for (const row of adSpend || []) {
      const raw = row.campaign_name || "Uncategorized";
      const campaign = normalizeCampaign(raw);
      const amount = numericAmount(row.amount);
      if (amount !== null) {
        spendByCampaign[campaign] = (spendByCampaign[campaign] || 0) + amount;
      }
      if (!displayNameMap[campaign]) displayNameMap[campaign] = raw;
    }

    // ─── 2. Leads (every counted lead, paged; one read feeds both tables) ───
    // A bare select stops at 1000 rows without saying so, so the panel is read
    // through the shared paged reader and counted with the shared definitions
    // (src/lib/lead-metrics.mjs): archived excluded, won = isWonLead, quality =
    // qualityBucket with "normal" its own column.
    const leadsResult = await fetchCountedLeads(
      supabase,
      "id,archived,campaign_name,stage,final_status,quotation_value,quality,ai_quality,source,source_platform,utm_source,fbclid,meta_click_id",
    );
    if (leadsResult.error) throw leadsResult.error;
    const allLeads = leadsResult.data as Array<MetricLead & {
      campaign_name?: string | null; utm_source?: string | null; fbclid?: string | null; meta_click_id?: string | null;
    }>;

    const META_PLATFORMS = new Set(["meta", "facebook", "instagram", "fb", "ins"]);
    const isMetaLead = (l: (typeof allLeads)[number]) =>
      l.source === "ins" || l.source === "fb" ||
      META_PLATFORMS.has(String(l.source_platform ?? "")) ||
      META_PLATFORMS.has(String(l.utm_source ?? "")) ||
      l.fbclid != null || l.meta_click_id != null;
    const metaLeads = allLeads.filter(isMetaLead);

    const totalMetaLeads = metaLeads.length;

    // Leads per campaign
    const leadsByCampaign: Record<string, number> = {};
    const conversionsByCampaign: Record<string, number> = {};
    const signedAmountByCampaign: Record<string, number> = {};

    for (const lead of metaLeads) {
      const raw = lead.campaign_name || "Uncategorized";
      const campaign = normalizeCampaign(raw);
      if (!displayNameMap[campaign]) displayNameMap[campaign] = raw;
      leadsByCampaign[campaign] = (leadsByCampaign[campaign] || 0) + 1;
      if (isWonLead(lead)) {
        conversionsByCampaign[campaign] = (conversionsByCampaign[campaign] || 0) + 1;
        signedAmountByCampaign[campaign] = (signedAmountByCampaign[campaign] || 0) + wonLeadValue(lead);
      }
    }

    const totalConversions = metaLeads.filter((l) => isWonLead(l)).length;
    const totalSignedAmount = metaLeads.reduce((sum, l) => sum + wonLeadValue(l), 0);

    // ─── 3. Campaign breakdown ───
    const allCampaigns = new Set([
      ...Object.keys(spendByCampaign),
      ...Object.keys(leadsByCampaign),
    ]);

    const campaignBreakdown = Array.from(allCampaigns)
      .map((campaign) => {
        const spend = spendByCampaign[campaign] ?? null;
        const leads = leadsByCampaign[campaign] || 0;
        const conversions = conversionsByCampaign[campaign] || 0;
        const signedAmount = signedAmountByCampaign[campaign] || 0;
        const cpl = spend !== null && leads > 0 ? Math.round((spend / leads) * 100) / 100 : null;
        const roas = spend !== null && spend > 0 ? Math.round((signedAmount / spend) * 100) / 100 : null;
        return {
          campaign: displayNameMap[campaign] || campaign,
          campaign_key: campaign,
          spend: spend === null ? null : Math.round(spend * 100) / 100,
          leads,
          cpl,
          conversions,
          signed_amount: Math.round(signedAmount * 100) / 100,
          roas,
        };
      })
      .sort((a, b) => (b.spend ?? -Infinity) - (a.spend ?? -Infinity));

    // ─── 4. Source vs Quality (shared definition; "normal" is its own column) ───
    const sourceQualityRows = sourceQualityBreakdown(allLeads);

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
      totalSpend !== null && totalMetaLeads > 0
        ? Math.round((totalSpend / totalMetaLeads) * 100) / 100
        : null;
    const overall_roas =
      totalSpend !== null && totalSpend > 0
        ? Math.round((totalSignedAmount / totalSpend) * 100) / 100
        : null;

    const unmatched_spend = Object.entries(spendByCampaign)
      .filter(([k]) => k === 'uncategorized')
      .reduce((s, [, v]) => s + v, 0);

    return NextResponse.json({
      period: {
        start_date: startDate,
        end_date: endDate,
      },
      summary: {
        total_spend: totalSpend === null ? null : Math.round(totalSpend * 100) / 100,
        total_leads: totalMetaLeads,
        cpl: overall_cpl,
        conversions: totalConversions,
        signed_amount: Math.round(totalSignedAmount * 100) / 100,
        roas: overall_roas,
      },
      campaign_breakdown: campaignBreakdown,
      unmatched_spend,
      source_quality: sourceQualityRows,
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
