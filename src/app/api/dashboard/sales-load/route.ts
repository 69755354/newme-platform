// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
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
      const { data: allLeads } = await supabase
        .from("leads")
        .select("id, assigned_to, stage, final_status, quotation_value, followup_count, last_contact_date, next_followup_date, created_at")
        .eq("archived", false)
        .in("assigned_to", repIds);

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

      const now = new Date().toISOString();
      const repStats = reps.map((rep: any) => {
        const myLeads = leadsByRep[rep.id] || [];
        const totalLeads = myLeads.length;
        const wonLeads = myLeads.filter((l: any) => l.final_status === "won").length;
        const contactedLeads = myLeads.filter(
          (l: any) => l.last_contact_date || (l.followup_count ?? 0) > 0
        ).length;
        const conversionRate = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0;
        const followupRate = totalLeads > 0 ? Math.round((contactedLeads / totalLeads) * 100) : 0;

        // Stage distribution
        const stageDist: Record<string, number> = {};
        myLeads.forEach((l: any) => {
          stageDist[l.stage] = (stageDist[l.stage] ?? 0) + 1;
        });

        // Overdue count
        const overdueCount = myLeads.filter(
          (l: any) =>
            l.next_followup_date && l.next_followup_date < now && !l.final_status
        ).length;

        return {
          id: rep.id,
          name: rep.full_name || rep.email,
          email: rep.email,
          role: rep.role,
          totalLeads,
          wonAmount: wonAmountByRep[rep.id] ?? 0,
          wonLeads,
          conversionRate,
          followupRate,
          stageDistribution: stageDist,
          overdueCount,
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
      const { data: myLeads } = await supabase
        .from("leads")
        .select("id, stage, final_status, followup_count, last_contact_date, next_followup_date, quotation_value")
        .eq("archived", false)
        .eq("assigned_to", user.id);

      const total = myLeads?.length ?? 0;
      const stageDist: Record<string, number> = {};
      const now = new Date().toISOString();
      let contactedCount = 0;
      let overdueCount = 0;

      (myLeads ?? []).forEach((l: any) => {
        stageDist[l.stage] = (stageDist[l.stage] ?? 0) + 1;
        if (l.last_contact_date || (l.followup_count ?? 0) > 0) contactedCount++;
        if (l.next_followup_date && l.next_followup_date < now && !l.final_status) {
          overdueCount++;
        }
      });

      const followupRate = total > 0 ? Math.round((contactedCount / total) * 100) : 0;

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
