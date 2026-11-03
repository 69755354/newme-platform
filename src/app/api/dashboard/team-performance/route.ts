// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { fetchAllRows, fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import { isActiveLead, isWonLead, leadSourceKey, type MetricLead } from "@/lib/lead-metrics.mjs";

type PerfLead = MetricLead & { id: string };
type PerfContract = { id: string; sales_id: string | null; lead_id: string | null; contract_amount: number | string | null; status: string | null };
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/team-performance
 *
 * Aggregates:
 *  - Per-salesperson metrics (leads, won, revenue, conversion, avg deal size)
 *  - Team totals + averages (for comparison)
 *  - Lead source breakdown (count / won / revenue per source)
 *
 * Management (admin/boss/operator) sees the whole team; sales sees only their own.
 * Revenue is derived from the contracts table (non-terminated contracts).
 */
export async function GET(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return applyPrivateNoStore(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  const isCEO = role === "admin" || role === "boss" || role === "operator";

  try {
    if (isCEO) {
      // ── Management: whole team ──
      const { data: reps } = await supabase
        .from("profiles")
        .select("id, full_name, email, role")
        .in("role", ["sales", "admin"]);

      const repList = reps ?? [];
      const repIds = repList.map((r: any) => r.id);

      const repIdSet = new Set<string>(repIds);
      const leadsResult = await fetchCountedLeads(supabase, "id,archived,assigned_to,source,source_platform,stage,final_status");
      if (leadsResult.error) throw leadsResult.error;
      const leads = (leadsResult.data as PerfLead[]).filter((l) => l.assigned_to && repIdSet.has(l.assigned_to));

      const contractsResult = await fetchAllRows((from, to, withCount) =>
        supabase
          .from("contracts")
          .select("id, sales_id, lead_id, contract_amount, status", withCount ? { count: "exact" } : undefined)
          .order("id", { ascending: true })
          .range(from, to),
      );
      if (contractsResult.error) throw contractsResult.error;
      const contracts = contractsResult.data as PerfContract[];

      const leadsByRep: Record<string, any[]> = {};
      (leads ?? []).forEach((l: any) => {
        (leadsByRep[l.assigned_to] ??= []).push(l);
      });

      const revenueByRep: Record<string, number> = {};
      const revenueByLead: Record<string, number> = {};
      (contracts ?? []).forEach((c: any) => {
        if (c.status === "terminated") return;
        const amt = Number(c.contract_amount ?? 0);
        if (c.sales_id) revenueByRep[c.sales_id] = (revenueByRep[c.sales_id] ?? 0) + amt;
        if (c.lead_id) revenueByLead[c.lead_id] = (revenueByLead[c.lead_id] ?? 0) + amt;
      });

      // Source breakdown (team-wide)
      const sourceStats: Record<string, { count: number; won: number; revenue: number }> = {};
      const bumpSource = (s: string) => {
        if (!sourceStats[s]) sourceStats[s] = { count: 0, won: 0, revenue: 0 };
        return sourceStats[s];
      };
      (leads ?? []).forEach((l: any) => {
        const s = bumpSource(leadSourceKey(l));
        s.count += 1;
        if (isWonLead(l)) s.won += 1;
      });
      (leads ?? []).forEach((l: any) => {
        const amt = revenueByLead[l.id] ?? 0;
        if (amt > 0) bumpSource(leadSourceKey(l)).revenue += amt;
      });

      const repStats = repList
        .map((rep: any) => {
          const myLeads = leadsByRep[rep.id] ?? [];
          const totalLeads = myLeads.length;
          const wonLeads = myLeads.filter((l: any) => isWonLead(l)).length;
          const activeLeads = myLeads.filter((l: any) => isActiveLead(l)).length;
          const revenue = revenueByRep[rep.id] ?? 0;
          const conversionRate = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0;
          const avgDealSize = wonLeads > 0 ? Math.round(revenue / wonLeads) : 0;
          return {
            id: rep.id,
            name: rep.full_name || rep.email || "Unknown",
            role: rep.role,
            totalLeads,
            wonLeads,
            activeLeads,
            revenue,
            conversionRate,
            avgDealSize,
          };
        })
        .filter((r: any) => r.totalLeads > 0 || r.revenue > 0)
        .sort((a: any, b: any) => b.revenue - a.revenue);

      const teamTotalLeads = repStats.reduce((s: number, r: any) => s + r.totalLeads, 0);
      const teamWonLeads = repStats.reduce((s: number, r: any) => s + r.wonLeads, 0);
      const teamRevenue = repStats.reduce((s: number, r: any) => s + r.revenue, 0);
      const activeReps = repStats.length || 1;

      return applyPrivateNoStore(NextResponse.json({
        isCEO: true,
        repStats,
        team: {
          totalLeads: teamTotalLeads,
          wonLeads: teamWonLeads,
          revenue: teamRevenue,
          conversionRate:
            teamTotalLeads > 0 ? Math.round((teamWonLeads / teamTotalLeads) * 100) : 0,
          avgDealSize: teamWonLeads > 0 ? Math.round(teamRevenue / teamWonLeads) : 0,
          avgLeads: Math.round(teamTotalLeads / activeReps),
          avgRevenue: Math.round(teamRevenue / activeReps),
          activeReps,
        },
        sources: Object.entries(sourceStats)
          .map(([source, v]) => ({ source, ...v }))
          .sort((a, b) => b.count - a.count),
      }));
    }

    // ── Sales: own data only ──
    const myLeadsResult = await fetchCountedLeads(
      supabase,
      "id,archived,source,source_platform,stage,final_status",
      { assignedTo: user.id },
    );
    if (myLeadsResult.error) throw myLeadsResult.error;
    const myLeadRows = myLeadsResult.data as PerfLead[];
    const myLeadIds = myLeadRows.map((l: any) => l.id);

    const { data: myContracts } = myLeadIds.length
      ? await supabase
          .from("contracts")
          .select("lead_id, contract_amount, status")
          .in("lead_id", myLeadIds)
      : { data: [] };

    const revenueByLead: Record<string, number> = {};
    let myRevenue = 0;
    (myContracts ?? []).forEach((c: any) => {
      if (c.status === "terminated") return;
      const amt = Number(c.contract_amount ?? 0);
      myRevenue += amt;
      if (c.lead_id) revenueByLead[c.lead_id] = (revenueByLead[c.lead_id] ?? 0) + amt;
    });

    const sourceStats: Record<string, { count: number; won: number; revenue: number }> = {};
    const bumpSource = (s: string) => {
      if (!sourceStats[s]) sourceStats[s] = { count: 0, won: 0, revenue: 0 };
      return sourceStats[s];
    };
    myLeadRows.forEach((l: any) => {
      const s = bumpSource(leadSourceKey(l));
      s.count += 1;
      if (isWonLead(l)) s.won += 1;
      s.revenue += revenueByLead[l.id] ?? 0;
    });

    const totalLeads = myLeadRows.length;
    const wonLeads = myLeadRows.filter((l: any) => isWonLead(l)).length;

    return applyPrivateNoStore(NextResponse.json({
      isCEO: false,
      repStats: [
        {
          id: user.id,
          name: profile?.full_name || "Me",
          role,
          totalLeads,
          wonLeads,
          activeLeads: myLeadRows.filter((l: any) => isActiveLead(l)).length,
          revenue: myRevenue,
          conversionRate: totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0,
          avgDealSize: wonLeads > 0 ? Math.round(myRevenue / wonLeads) : 0,
        },
      ],
      team: null,
      sources: Object.entries(sourceStats)
        .map(([source, v]) => ({ source, ...v }))
        .sort((a, b) => b.count - a.count),
    }));
  } catch (err: any) {
    console.error("[team-performance] error:", err);
    return applyPrivateNoStore(NextResponse.json({ error: "Failed to fetch team performance" }, { status: 500 }));
  }
}
