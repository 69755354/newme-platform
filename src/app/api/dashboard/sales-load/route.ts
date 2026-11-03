// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import { LEAD_METRIC_COLUMNS, summarizeLeads, type MetricLead } from "@/lib/lead-metrics.mjs";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";

export const dynamic = "force-dynamic";

// ─── GET /api/dashboard/sales-load ───
export async function GET(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

  // 1. Authenticate
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return applyPrivateNoStore(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }

  // 2. Get role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  const isCEO = role === "admin" || role === "boss" || role === "operator";

  try {
    if (isCEO) {
      // ── CEO view: all sales reps ──
      const { data: salesReps } = await supabase
        .from("profiles")
        .select("id, full_name, email, role")
        .in("role", ["sales", "admin"]);

      const reps = salesReps ?? [];

      // Get all leads assigned to these reps
      const repIds = reps.map((r: any) => r.id);
      const repIdSet = new Set<string>(repIds);
      const leadsResult = await fetchCountedLeads(supabase, LEAD_METRIC_COLUMNS);
      if (leadsResult.error) throw leadsResult.error;
      const allLeads = (leadsResult.data as MetricLead[]).filter(
        (l) => l.assigned_to && repIdSet.has(l.assigned_to),
      );

      const leadsByRep: Record<string, any[]> = {};
      (allLeads ?? []).forEach((l: any) => {
        if (!leadsByRep[l.assigned_to]) leadsByRep[l.assigned_to] = [];
        leadsByRep[l.assigned_to].push(l);
      });

      // Get won amounts per rep from contracts
      const { data: contracts } = await supabase
        .from("contracts")
        .select("sales_id, contract_amount, status");

      const wonAmountByRep: Record<string, number> = {};
      (contracts ?? []).forEach((c: any) => {
        if (c.status !== "terminated" && c.sales_id) {
          wonAmountByRep[c.sales_id] = (wonAmountByRep[c.sales_id] ?? 0) + (c.contract_amount ?? 0);
        }
      });

      const now = new Date();
      const repStats = reps.map((rep: any) => {
        const myLeads = leadsByRep[rep.id] || [];
        // Same definitions as the dashboard (src/lib/lead-metrics.mjs).
        const mine = summarizeLeads(myLeads, { now });
        const stageDist = Object.fromEntries(
          Object.entries(mine.stageCounts).filter(([, count]) => count > 0),
        );

        return {
          id: rep.id,
          name: rep.full_name || rep.email,
          email: rep.email,
          role: rep.role,
          totalLeads: mine.total,
          wonAmount: wonAmountByRep[rep.id] ?? 0,
          wonLeads: mine.won,
          conversionRate: mine.conversionRate,
          followupRate: mine.contactRate,
          stageDistribution: stageDist,
          overdueCount: mine.followUpOverdue,
          // Transferable: stage='new' AND last_contact_date IS NULL
          transferableLeads: myLeads
            .filter((l: any) => l.stage === "new" && !l.last_contact_date)
            .map((l: any) => ({ id: l.id })),
        };
      });

      // Calculate average load and detect imbalance
      const avgLoad =
        repStats.length > 0
          ? repStats.reduce((s: number, r: any) => s + r.totalLeads, 0) / repStats.length
          : 0;
      const imbalanceThreshold = avgLoad * 1.5;

      const overloaded = repStats.filter((r: any) => r.totalLeads > imbalanceThreshold);
      const underloaded = repStats.filter((r: any) => r.totalLeads < avgLoad);
      const imbalanceDetected = overloaded.length > 0 && underloaded.length > 0;

      return applyPrivateNoStore(NextResponse.json({
        repStats,
        avgLoad: Math.round(avgLoad * 10) / 10,
        imbalanceDetected,
        overloaded: overloaded.map((r: any) => ({ id: r.id, name: r.name, totalLeads: r.totalLeads })),
        underloaded: underloaded.map((r: any) => ({ id: r.id, name: r.name, totalLeads: r.totalLeads })),
        isCEO: true,
      }));
    } else {
      // ── Sales view: my own stats ──
      const mineResult = await fetchCountedLeads(supabase, LEAD_METRIC_COLUMNS, { assignedTo: user.id });
      if (mineResult.error) throw mineResult.error;
      const mine = summarizeLeads(mineResult.data as MetricLead[], { now: new Date() });
      const total = mine.total;
      const stageDist = Object.fromEntries(
        Object.entries(mine.stageCounts).filter(([, count]) => count > 0),
      );
      const followupRate = mine.contactRate;
      const overdueCount = mine.followUpOverdue;

      return applyPrivateNoStore(NextResponse.json({
        totalLeads: total,
        stageDistribution: stageDist,
        followupRate,
        overdueCount,
        isCEO: false,
      }));
    }
  } catch (err: any) {
    console.error("Sales load API error:", err);
    return applyPrivateNoStore(NextResponse.json({ error: "Failed to fetch sales load data" }, { status: 500 }));
  }
}
