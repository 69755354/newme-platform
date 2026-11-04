// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import {
  LEAD_METRIC_COLUMNS,
  overdueLeadList,
  percentOf,
  summarizeLeads,
  type MetricLead,
} from "@/lib/lead-metrics.mjs";

// ─── GET /api/dashboard/lead-health ───
export async function GET(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

  // 1. Authenticate
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Get role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  const isCEO = role === "admin" || role === "boss" || role === "operator";
  const now = new Date();

  try {
    // One read of the counted (non-archived) leads, one definition of every
    // figure (src/lib/lead-metrics.mjs) - the same numbers as the dashboard.
    const leadsResult = await fetchCountedLeads(
      supabase,
      `${LEAD_METRIC_COLUMNS},customer_name,phone`,
      { assignedTo: isCEO ? null : user.id },
    );
    if (leadsResult.error) throw leadsResult.error;
    const rows = leadsResult.data as Array<MetricLead & { customer_name?: string | null; phone?: string | null }>;
    const stats = summarizeLeads(rows, { now });
    const total = stats.total;

    // Overdue follow-ups: most days late first, top 20, plus the true total.
    const overdueAll = overdueLeadList(rows, now);
    const overdueTop = overdueAll.slice(0, 20);

    // Resolve assigned_to names
    const assignedIds = [...new Set(overdueTop.map((r) => r.lead.assigned_to).filter(Boolean))] as string[];
    const nameMap: Record<string, string> = {};
    if (assignedIds.length > 0) {
      const { data: users } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", assignedIds);
      (users ?? []).forEach((u: any) => { nameMap[u.id] = u.full_name; });
    }

    const overdue = overdueTop.map(({ lead: r, overdueDays }) => ({
      id: r.id,
      customer_name: r.customer_name,
      phone: r.phone,
      assigned_to: r.assigned_to,
      assigned_name: (r.assigned_to && nameMap[r.assigned_to]) || null,
      stage: r.stage,
      last_contact_date: r.last_contact_date,
      next_followup_date: r.next_followup_date,
      overdue_days: overdueDays,
      quotation_value: r.quotation_value,
    }));

    return NextResponse.json({
      totalLeads: total,
      weeklyNew: stats.newLast7Days,
      activeCount: stats.active,
      activePct: percentOf(stats.active, total),
      dormantCount: stats.dormant,
      dormantPct: percentOf(stats.dormant, total),
      zeroCount: stats.zeroFollowup,
      zeroPct: percentOf(stats.zeroFollowup, total),
      qualityBreakdown: stats.qualityBreakdown,
      overdue,
      overdueTotal: overdueAll.length,
      isCEO,
    });
  } catch (err: any) {
    console.error("Lead health API error:", err);
    return NextResponse.json({ error: "Failed to fetch lead health data" }, { status: 500 });
  }
}
