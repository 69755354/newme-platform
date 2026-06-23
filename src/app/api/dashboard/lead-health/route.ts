import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

// ─── GET /api/dashboard/lead-health ───
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabase();

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
  const now = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();

  try {
    // ── Base query builder ──
    let baseQuery = supabase.from("leads").select("*", { count: "exact" });
    if (!isCEO) {
      baseQuery = baseQuery.eq("assigned_to", user.id);
    }

    // ── Total leads ──
    const { count: totalLeads } = await baseQuery;
    const total = totalLeads ?? 0;

    // ── Weekly new leads ──
    let weeklyQuery = supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", weekAgo);
    if (!isCEO) weeklyQuery = weeklyQuery.eq("assigned_to", user.id);
    const { count: weeklyNew } = await weeklyQuery;

    // ── Active leads ──
    // lead_status IN ('hot', 'warm') OR last_contact_date > NOW() - 7d
    let activeQuery = supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .or(`lead_status.in.(hot,warm),last_contact_date.gt.${weekAgo}`);
    if (!isCEO) activeQuery = activeQuery.eq("assigned_to", user.id);
    const { count: activeCount } = await activeQuery;
    const activePct = total > 0 ? Math.round((activeCount ?? 0) / total * 100) : 0;

    // ── Dormant leads ──
    // lead_status = 'dormant' OR (last_contact_date < NOW() - 14d AND stage NOT IN ('won', 'lost'))
    let dormantQuery = supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .or(
        `lead_status.eq.dormant,and(last_contact_date.lt.${fourteenDaysAgo},not.stage.in.(won,lost))`
      );
    if (!isCEO) dormantQuery = dormantQuery.eq("assigned_to", user.id);
    const { count: dormantCount } = await dormantQuery;
    const dormantPct = total > 0 ? Math.round((dormantCount ?? 0) / total * 100) : 0;

    // ── Zero followup leads ──
    // followup_count = 0 OR last_contact_date IS NULL
    let zeroQuery = supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .or("followup_count.eq.0,last_contact_date.is.null");
    if (!isCEO) zeroQuery = zeroQuery.eq("assigned_to", user.id);
    const { count: zeroCount } = await zeroQuery;
    const zeroPct = total > 0 ? Math.round((zeroCount ?? 0) / total * 100) : 0;

    // ── Quality breakdown ──
    // We check the `quality` field first, fallback to `ai_quality`
    // Values: 'pending', 'good', 'bad', 'unknown'
    let qualityQuery = supabase
      .from("leads")
      .select("quality, ai_quality");
    if (!isCEO) qualityQuery = qualityQuery.eq("assigned_to", user.id);
    const { data: qualityRows } = await qualityQuery;

    const qualityBreakdown: Record<string, number> = {
      pending: 0,
      good: 0,
      bad: 0,
      unknown: 0,
    };
    (qualityRows ?? []).forEach((r: any) => {
      const q = r.quality || r.ai_quality || "unknown";
      if (qualityBreakdown[q] !== undefined) {
        qualityBreakdown[q]++;
      } else {
        qualityBreakdown.unknown++;
      }
    });

    // ── Overdue followups ──
    // next_followup_date < NOW() OR (last_contact_date IS NULL AND created_at < NOW() - 48h)
    // ORDER BY overdue_days DESC, LIMIT 20
    let overdueQuery = supabase
      .from("leads")
      .select(`
        id, customer_name, phone, assigned_to, stage, last_contact_date,
        next_followup_date, followup_count, created_at, quotation_value
      `)
      .or(
        `next_followup_date.lt.${now},and(last_contact_date.is.null,created_at.lt.${twoDaysAgo})`
      )
      .order("next_followup_date", { ascending: true, nullsFirst: false })
      .limit(20);
    if (!isCEO) overdueQuery = overdueQuery.eq("assigned_to", user.id);
    const { data: overdueRaw } = await overdueQuery;

    // Resolve assigned_to names
    const assignedIds = [...new Set((overdueRaw ?? []).map((r: any) => r.assigned_to).filter(Boolean))];
    let nameMap: Record<string, string> = {};
    if (assignedIds.length > 0) {
      const { data: users } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", assignedIds);
      (users ?? []).forEach((u: any) => { nameMap[u.id] = u.full_name; });
    }

    const overdue = (overdueRaw ?? []).map((r: any) => {
      const overdueDays = r.next_followup_date
        ? Math.max(0, Math.floor((Date.now() - new Date(r.next_followup_date).getTime()) / 86_400_000))
        : Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86_400_000) - 2);
      return {
        id: r.id,
        customer_name: r.customer_name,
        phone: r.phone,
        assigned_to: r.assigned_to,
        assigned_name: nameMap[r.assigned_to] || null,
        stage: r.stage,
        last_contact_date: r.last_contact_date,
        next_followup_date: r.next_followup_date,
        overdue_days: overdueDays,
        quotation_value: r.quotation_value,
      };
    }).sort((a: any, b: any) => b.overdue_days - a.overdue_days).slice(0, 20);

    return NextResponse.json({
      totalLeads: total,
      weeklyNew: weeklyNew ?? 0,
      activeCount: activeCount ?? 0,
      activePct,
      dormantCount: dormantCount ?? 0,
      dormantPct,
      zeroCount: zeroCount ?? 0,
      zeroPct,
      qualityBreakdown,
      overdue,
      isCEO,
    });
  } catch (err: any) {
    console.error("Lead health API error:", err);
    return NextResponse.json({ error: "Failed to fetch lead health data" }, { status: 500 });
  }
}
