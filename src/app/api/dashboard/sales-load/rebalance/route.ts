// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { filterLeadTransferCandidateQuery } from "@/lib/lead-transfer-candidates.mjs";

// ─── POST /api/dashboard/sales-load/rebalance ───
// Round-robin transfer of transferable leads from overloaded reps to underloaded reps
export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

  // 1. Authenticate
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Check admin/boss role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  if (role !== "admin" && role !== "boss") {
    return NextResponse.json({ error: "Only admins can rebalance" }, { status: 403 });
  }

  try {
    // ── Fetch all sales reps ──
    const repsQuery = supabase
      .from("profiles")
      .select("id, full_name, email, role, is_active");
    const eligibleRepsQuery = filterLeadTransferCandidateQuery(
      repsQuery as never
    ) as typeof repsQuery;
    const { data: salesReps, error: salesRepsErr } = await eligibleRepsQuery;
    if (salesRepsErr) throw salesRepsErr;

    const reps = salesReps ?? [];
    const repIds = reps.map((r: any) => r.id);

    // ── Get leads per rep ──
    const { data: allLeads } = await supabase
      .from("leads")
      .select("id, assigned_to")
      .in("assigned_to", repIds);

    const leadsByRep: Record<string, number> = {};
    (allLeads ?? []).forEach((l: any) => {
      leadsByRep[l.assigned_to] = (leadsByRep[l.assigned_to] ?? 0) + 1;
    });

    // ── Identify overloaded and underloaded ──
    const leadCounts = reps.map((r: any) => ({
      id: r.id,
      name: r.full_name || r.email,
      count: leadsByRep[r.id] ?? 0,
    }));

    const avgLoad =
      leadCounts.length > 0
        ? leadCounts.reduce((s, r) => s + r.count, 0) / leadCounts.length
        : 0;
    const imbalanceThreshold = avgLoad * 1.5;

    const overloaded = leadCounts.filter((r) => r.count > imbalanceThreshold);
    const underloaded = leadCounts.filter((r) => r.count < avgLoad);

    if (overloaded.length === 0 || underloaded.length === 0) {
      return NextResponse.json({
        message: "No imbalance detected. Nothing to rebalance.",
        transferred: 0,
      });
    }

    // ── Find transferable leads from overloaded reps ──
    // Transferable: stage='new' AND last_contact_date IS NULL
    const overloadedIds = overloaded.map((r) => r.id);
    const { data: transferableRaw } = await supabase
      .from("leads")
      .select("id, assigned_to, customer_name")
      .in("assigned_to", overloadedIds)
      .eq("stage", "new")
      .is("last_contact_date", null);

    const transferable = transferableRaw ?? [];

    if (transferable.length === 0) {
      return NextResponse.json({
        message: "No transferable leads found (new leads with no contact).",
        transferred: 0,
      });
    }

    // ── Round-robin assign ──
    let idx = 0;
    const updates: { id: string; assigned_to: string }[] = [];

    for (const lead of transferable) {
      const target = underloaded[idx % underloaded.length];
      if (lead.assigned_to !== target.id) {
        updates.push({ id: lead.id, assigned_to: target.id });
      }
      idx++;
    }

    if (updates.length === 0) {
      return NextResponse.json({
        message: "All transferable leads already assigned to underloaded reps.",
        transferred: 0,
      });
    }

    // ── Execute batch update ──
    let transferred = 0;
    const failedLeadIds: string[] = [];
    for (const update of updates) {
      const { data: updated, error } = await supabase
        .from("leads")
        .update({ assigned_to: update.assigned_to })
        .eq("id", update.id)
        .select("id")
        .maybeSingle();
      if (error || !updated) {
        failedLeadIds.push(update.id);
        continue;
      }
      transferred++;
    }

    if (failedLeadIds.length > 0) {
      return NextResponse.json({
        error: `Rebalance partially failed for ${failedLeadIds.length} lead(s).`,
        transferred,
        failed: failedLeadIds.length,
      }, { status: 500 });
    }

    return NextResponse.json({
      message: `Rebalanced ${transferred} leads across ${underloaded.length} reps.`,
      transferred,
      from: overloaded.map((r) => r.name),
      to: underloaded.map((r) => r.name),
    });
  } catch (err: any) {
    console.error("Rebalance API error:", err);
    return NextResponse.json({ error: "Failed to rebalance" }, { status: 500 });
  }
}
