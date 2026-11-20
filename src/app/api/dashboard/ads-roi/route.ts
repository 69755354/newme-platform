// RBAC: user (boss, admin)
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { fetchAllRows, fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import { EXCLUDE_SYNTHETIC_QA_FILTER, sourceQualityBreakdown, type MetricLead } from "@/lib/lead-metrics.mjs";
import { adLabel, buildAdBreakdown, buildAdNameMap, costPerLead, resolveAdsWindow, spendFreshness, weeklyLeadCost } from "@/lib/ads-leads.mjs";

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
 * Ad spend -> leads -> cost per lead for the CEO/Admin view. It stops at leads: no quotation,
 * contract or won amount, no return-on-spend ratio.
 * Query: `days` (default 30, ending today in Dubai) or `since`+`until` (Dubai dates, inclusive).
 * Spend and leads are always read over the SAME Dubai-date window.
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

    // Check role - only boss/admin can see ad ROI
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile?.role || !["boss", "admin"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const window = resolveAdsWindow({
      days: params.get("days") ?? undefined,
      since: params.get("since") ?? undefined,
      until: params.get("until") ?? undefined,
    });
    if ("error" in window) return NextResponse.json({ error: window.error }, { status: 400 });

    // --- 1. Ad spend inside the window ---
    // Every ad_spend row is summed, with no filter on `source`. That is correct
    // only because no spend_date is described by two sources at once: both writers
    // refuse a window that another source already covers
    // (src/app/api/meta/ads-sync/route.ts -> overlapping_spend_window,
    //  src/app/api/dashboard/ads-roi/import/route.ts -> api_sourced_days_would_be_double_counted),
    // and tests/security/meta-ads-sync-contract.test.mjs fails if either fence is
    // removed. Filtering to one source here instead would be worse: it would hide
    // the Excel history rather than total the advertising.
    const spendResult = await fetchAllRows((from, to, withCount) =>
      supabase
        .from("ad_spend")
        .select("id, spend_date, campaign_name, adset_name, ad_name, amount", withCount ? { count: "exact" } : undefined)
        .gte("spend_date", window.since)
        .lte("spend_date", window.until)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (spendResult.error) throw spendResult.error;
    const adSpend = spendResult.data as Array<{ spend_date: string; campaign_name: string | null; ad_name: string | null; amount: number | null }>;

    const knownSpend = adSpend
      .map((row) => numericAmount(row.amount))
      .filter((amount): amount is number => amount !== null);
    const totalSpend = knownSpend.length > 0
      ? knownSpend.reduce((sum, amount) => sum + amount, 0)
      : null;

    // --- 2. Ad leads inside the SAME window (paged: a bare select stops at 1000 rows silently) ---
    // Includes click-to-WhatsApp leads (ctwa_clid / ad_id, source "whatsapp"), which carry no campaign name.
    const metaLeadsResult = await fetchAllRows((from, to, withCount) =>
      supabase
        .from("leads")
        .select("id, campaign_name, ad_id, ad_name, ctwa_clid, created_at, source, source_platform, utm_source, fbclid, meta_click_id, archived", withCount ? { count: "exact" } : undefined)
        .or("source.in.(ins,fb),source_platform.in.(meta,facebook,instagram,fb,ins),utm_source.in.(meta,facebook,instagram,fb,ins),fbclid.not.is.null,meta_click_id.not.is.null,ctwa_clid.not.is.null,ad_id.not.is.null")
        .eq("archived", false)
        .or(EXCLUDE_SYNTHETIC_QA_FILTER)
        .gte("created_at", window.startInstant.toISOString())
        .lt("created_at", window.endInstant.toISOString())
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (metaLeadsResult.error) throw metaLeadsResult.error;
    const metaLeads = metaLeadsResult.data as Array<{
      campaign_name?: string | null; ad_id?: string | null; ad_name?: string | null; created_at: string;
    }>;
    const totalMetaLeads = metaLeads.length;
    const adNames = buildAdNameMap(metaLeads);

    // --- 3. Per campaign. A lead with no campaign name but an ad id (click-to-WhatsApp) is listed under its ad. ---
    const spendByCampaign: Record<string, number> = {};
    const leadsByCampaign: Record<string, number> = {};
    const displayNameMap: Record<string, string> = {};
    for (const row of adSpend) {
      const raw = row.campaign_name || "Uncategorized";
      const campaign = normalizeCampaign(raw);
      const amount = numericAmount(row.amount);
      if (amount !== null) spendByCampaign[campaign] = (spendByCampaign[campaign] || 0) + amount;
      if (!displayNameMap[campaign]) displayNameMap[campaign] = raw;
    }
    for (const lead of metaLeads) {
      let campaign: string;
      if (lead.campaign_name) {
        campaign = normalizeCampaign(lead.campaign_name);
        if (!displayNameMap[campaign]) displayNameMap[campaign] = lead.campaign_name;
      } else if (lead.ad_id) {
        campaign = `ad-${lead.ad_id}`;
        displayNameMap[campaign] = adLabel(lead.ad_id, lead.ad_name || adNames.get(lead.ad_id));
      } else {
        campaign = normalizeCampaign(null);
        if (!displayNameMap[campaign]) displayNameMap[campaign] = "Uncategorized";
      }
      leadsByCampaign[campaign] = (leadsByCampaign[campaign] || 0) + 1;
    }

    const campaignBreakdown = Array.from(new Set([...Object.keys(spendByCampaign), ...Object.keys(leadsByCampaign)]))
      .map((campaign) => {
        const spend = spendByCampaign[campaign] ?? null;
        const leads = leadsByCampaign[campaign] || 0;
        return {
          campaign: displayNameMap[campaign] || campaign,
          campaign_key: campaign,
          spend: spend === null ? null : Math.round(spend * 100) / 100,
          leads,
          cpl: costPerLead(spend ?? undefined, leads),
        };
      })
      .sort((a, b) => (b.spend ?? -Infinity) - (a.spend ?? -Infinity) || b.leads - a.leads);

    // --- 4. Per ad: leads by ad id (the name only labels); spend joins by name, ambiguous names are flagged, not guessed ---
    const adBreakdown = buildAdBreakdown(adSpend, metaLeads, adNames);

    // --- 5. Per Dubai ISO week ---
    const weeklyBreakdown = weeklyLeadCost(adSpend, metaLeads);

    // --- 6. Source vs Quality (every counted lead, paged; shared definition, "normal" its own column) ---
    const allLeadsResult = await fetchCountedLeads(supabase, "id,archived,source,source_platform,final_status,stage,quality,ai_quality");
    if (allLeadsResult.error) throw allLeadsResult.error;
    const sourceQualityRows = sourceQualityBreakdown(allLeadsResult.data as MetricLead[]);

    // --- 7. Freshness: newest spend date over ALL history (the window may hold none) ---
    const { data: newest } = await supabase
      .from("ad_spend")
      .select("spend_date")
      .order("spend_date", { ascending: false })
      .limit(1);
    const freshness = spendFreshness(newest && newest.length > 0 ? newest[0].spend_date : null);

    const unmatched_spend = Object.entries(spendByCampaign)
      .filter(([k]) => k === "uncategorized")
      .reduce((s, [, v]) => s + v, 0);

    return NextResponse.json({
      period: { start_date: window.since, end_date: window.until },
      data_last_updated: freshness.last_date,
      spend_stale: freshness.stale,
      spend_days_old: freshness.days_old,
      summary: {
        total_spend: totalSpend === null ? null : Math.round(totalSpend * 100) / 100,
        total_leads: totalMetaLeads,
        cpl: costPerLead(totalSpend ?? undefined, totalMetaLeads),
      },
      campaign_breakdown: campaignBreakdown,
      ad_breakdown: adBreakdown,
      weekly_breakdown: weeklyBreakdown,
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
