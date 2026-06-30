import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/dashboard/lead-sources
 *
 * C4 — Lead source / asset analysis.
 * Aggregates, per lead `source` (meta_ads/whatsapp/website/offline/referral/other):
 *   - count, won, conversionRate, revenue
 *   - quality distribution via `lead_status` (hot/warm/cold/dormant + unknown)
 *   - sales assignment: how many leads each rep owns, per source
 *
 * Management (admin/boss/operator) sees the whole pool; sales sees only their own.
 * Revenue is derived from the contracts table (non-terminated contracts) joined
 * back to the lead's source.
 */
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabase();

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  const isCEO = role === "admin" || role === "boss" || role === "operator";

  try {
    // ── Base lead query ──
    let leadQuery = supabase
      .from("leads")
      .select("id, source, stage, lead_status, final_status, assigned_to")
      .eq("archived", false);
    if (!isCEO) leadQuery = leadQuery.eq("assigned_to", user.id);
    const { data: leads } = await leadQuery;
    const leadRows = (leads ?? []) as any[];

    // ── Revenue per lead (from contracts, non-terminated) ──
    const leadIds = leadRows.map((l) => l.id);
    const revenueByLead: Record<string, number> = {};
    if (leadIds.length > 0) {
      const { data: contracts } = await supabase
        .from("contracts")
        .select("lead_id, contract_amount, status")
        .in("lead_id", leadIds);
      (contracts ?? []).forEach((c: any) => {
        if (c.status === "terminated" || !c.lead_id) return;
        revenueByLead[c.lead_id] = (revenueByLead[c.lead_id] ?? 0) + Number(c.contract_amount ?? 0);
      });
    }

    // ── Rep name lookup (for sales assignment) ──
    const repIds = [...new Set(leadRows.map((l) => l.assigned_to).filter(Boolean))] as string[];
    const repNames: Record<string, string> = {};
    if (repIds.length > 0) {
      const { data: reps } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", repIds);
      (reps ?? []).forEach((r: any) => {
        repNames[r.id] = r.full_name || r.email || "Unknown";
      });
    }

    // ── Per-source aggregation ──
    const SOURCE_ORDER = ["meta_ads", "whatsapp", "website", "offline", "referral", "other"];
    const srcAgg: Record<string, {
      count: number; won: number; revenue: number;
      quality: Record<string, number>;
      assignment: Record<string, number>; // rep_id → count
    }> = {};

    const bump = (s: string) => {
      const key = s || "other";
      if (!srcAgg[key]) {
        srcAgg[key] = { count: 0, won: 0, revenue: 0, quality: { hot: 0, warm: 0, cold: 0, dormant: 0, unknown: 0 }, assignment: {} };
      }
      return srcAgg[key];
    };

    leadRows.forEach((l) => {
      const a = bump(l.source);
      a.count += 1;
      if (l.final_status === "won") a.won += 1;
      const rev = revenueByLead[l.id] ?? 0;
      if (rev > 0) a.revenue += rev;

      const q = l.lead_status || "unknown";
      if (a.quality[q] === undefined) a.quality.unknown += 1;
      else a.quality[q] += 1;

      if (l.assigned_to) a.assignment[l.assigned_to] = (a.assignment[l.assigned_to] ?? 0) + 1;
    });

    const knownSources = Object.keys(srcAgg);
    const orderedSources = [
      ...SOURCE_ORDER.filter((s) => srcAgg[s]),
      ...knownSources.filter((s) => !SOURCE_ORDER.includes(s)),
    ];

    const sources = orderedSources.map((source) => {
      const a = srcAgg[source];
      const conversionRate = a.count > 0 ? Math.round((a.won / a.count) * 100) : 0;
      return {
        source,
        count: a.count,
        won: a.won,
        conversionRate,
        revenue: a.revenue,
        quality: a.quality,
      };
    });

    // ── Assignment: flattened per (source, rep) ──
    const assignment: Array<{ source: string; rep_id: string; rep_name: string; count: number }> = [];
    orderedSources.forEach((source) => {
      const a = srcAgg[source];
      Object.entries(a.assignment)
        .sort(([, x], [, y]) => y - x)
        .forEach(([repId, count]) => {
          assignment.push({ source, rep_id: repId, rep_name: repNames[repId] ?? "Unknown", count });
        });
    });

    // ── Team-wide totals (for context) ──
    const totalCount = sources.reduce((s, x) => s + x.count, 0);
    const totalWon = sources.reduce((s, x) => s + x.won, 0);
    const overallQuality = { hot: 0, warm: 0, cold: 0, dormant: 0, unknown: 0 } as Record<string, number>;
    sources.forEach((s) => Object.entries(s.quality).forEach(([k, v]) => { overallQuality[k] = (overallQuality[k] ?? 0) + v; }));

    return NextResponse.json({
      isCEO,
      sources,
      assignment,
      totals: {
        count: totalCount,
        won: totalWon,
        conversionRate: totalCount > 0 ? Math.round((totalWon / totalCount) * 100) : 0,
        quality: overallQuality,
      },
    });
  } catch (err: any) {
    console.error("[lead-sources] error:", err);
    return NextResponse.json({ error: "Failed to fetch lead source analysis" }, { status: 500 });
  }
}
