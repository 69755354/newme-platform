// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

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
    if (isCEO) {
      // ── Management: whole team ──
      const { data: reps } = await supabase
        .from("profiles")
        .select("id, full_name, email, role")
        .in("role", ["sales", "admin"]);

      const repList = reps ?? [];
      const repIds = repList.map((r: any) => r.id);

      const { data: leads } = await supabase
        .from("leads")
        .select("id, assigned_to, source, stage, final_status")
        .eq("archived", false)
        .in("assigned_to", repIds);

      const { data: contracts } = await supabase
        .from("contracts")
        .select("id, sales_id, lead_id, contract_amount, status");

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
        const s = bumpSource(l.source || "other");
        s.count += 1;
        if (l.final_status === "won") s.won += 1;
      });
      (leads ?? []).forEach((l: any) => {
        const amt = revenueByLead[l.id] ?? 0;
        if (amt > 0) bumpSource(l.source || "other").revenue += amt;
      });

      const repStats = repList
        .map((rep: any) => {
          const myLeads = leadsByRep[rep.id] ?? [];
          const totalLeads = myLeads.length;
          const wonLeads = myLeads.filter((l: any) => l.final_status === "won").length;
          const activeLeads = myLeads.filter(
            (l: any) => !l.final_status
          ).length;
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

      return NextResponse.json({
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
      });
    }

    // ── Sales: own data only ──
    const { data: myLeads } = await supabase
      .from("leads")
      .select("id, source, stage, final_status")
      .eq("archived", false)
      .eq("assigned_to", user.id);

    const myLeadRows = myLeads ?? [];
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
      const s = bumpSource(l.source || "other");
      s.count += 1;
      if (l.final_status === "won") s.won += 1;
      s.revenue += revenueByLead[l.id] ?? 0;
    });

    const totalLeads = myLeadRows.length;
    const wonLeads = myLeadRows.filter((l: any) => l.final_status === "won").length;

    return NextResponse.json({
      isCEO: false,
      repStats: [
        {
          id: user.id,
          name: profile?.full_name || "Me",
          role,
          totalLeads,
          wonLeads,
          activeLeads: myLeadRows.filter((l: any) => !l.final_status).length,
          revenue: myRevenue,
          conversionRate: totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0,
          avgDealSize: wonLeads > 0 ? Math.round(myRevenue / wonLeads) : 0,
        },
      ],
      team: null,
      sources: Object.entries(sourceStats)
        .map(([source, v]) => ({ source, ...v }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (err: any) {
    console.error("[team-performance] error:", err);
    return NextResponse.json({ error: "Failed to fetch team performance" }, { status: 500 });
  }
}
