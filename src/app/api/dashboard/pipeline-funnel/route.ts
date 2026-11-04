// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { fetchCountedLeads, fetchLostEvents } from "@/lib/fetch-all-rows.mjs";
import { lostFromStageCounts } from "@/lib/lead-metrics.mjs";
import type { Database } from "@/types/database";

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
type PipelineLead = Pick<LeadRow, "id" | "stage" | "created_at" | "updated_at" | "last_contact_date" | "assigned_to" | "customer_name" | "current_milestone" | "final_status">;

/**
 * GET /api/dashboard/pipeline-funnel
 *
 * Returns funnel data grouped by lead stage.
 * CEO/Admin: all leads. Sales: only assigned leads.
 *
 * Response shape:
 * {
 *   stages: { key, label, count, pctOfTop, conversionToNext, avgDaysInStage, isBottleneck }[]
 *   stuckLeads: { id, customer_name, stage, days_in_stage }[]
 * }
 */

// won/lost live in final_status; process stages in current_milestone (the funnel
// and the daily funnel snapshot both bucket by completed milestone).
function normalizeMilestone(milestone: string): string {
  switch (milestone) {
    case "first_contact":  return "contacted";
    case "requirements":   return "requirement_confirmed";
    case "drawings":       return "solution_submitted";
    case "quotation":      return "quotation_submitted";
    case "meeting":        return "negotiation"; // meeting done → in negotiation
    default:               return milestone; // unknown → pass through as-is
  }
}

export async function GET(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user role
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    const role = profile?.role ?? "sales";
    const isManagement = ["admin", "boss", "operator"].includes(role);

    const { searchParams } = new URL(request.url);
    const userIdParam = searchParams.get("user_id");
    // Security: sales can only see their own data, ignore user_id param
    const targetUserId = isManagement ? userIdParam : user.id;

    // ─── Pipeline stage definitions (ordered) ───
    const STAGE_DEFS = [
      { key: "new",                label: "New" },
      { key: "contacted",          label: "Contacted" },
      { key: "requirement_confirmed", label: "Req. Confirmed" },
      { key: "solution_submitted", label: "Solution Sub." },
      { key: "quotation_submitted",label: "Quotation Sub." },
      { key: "negotiation",        label: "Negotiation" },
      { key: "pending_decision",   label: "Pending Decision" },
      { key: "won",                label: "Won" },
      { key: "lost",               label: "Lost" },
    ];

    // ─── Step 1: Query leads count per stage ───
    const leadsResult = await fetchCountedLeads(
      supabase,
      "id,archived,stage,created_at,updated_at,last_contact_date,assigned_to,customer_name,current_milestone,final_status",
      { assignedTo: targetUserId },
    );
    if (leadsResult.error) {
      console.error("[pipeline-funnel] Failed to fetch leads:", leadsResult.error);
      return NextResponse.json({ error: "Failed to fetch leads" }, { status: 500 });
    }
    const leads = leadsResult.data as PipelineLead[];

    const totalLeads = leads.length;

    // ─── Step 2: Build stage counts ───
    const stageCountMap: Record<string, number> = {};
    const stageLeads: Record<string, PipelineLead[]> = {};
    for (const def of STAGE_DEFS) {
      stageCountMap[def.key] = 0;
      stageLeads[def.key] = [];
    }

    for (const l of leads || []) {
      const s = l.final_status || normalizeMilestone(l.current_milestone || "new");
      if (stageCountMap[s] !== undefined) {
        stageCountMap[s]++;
        stageLeads[s].push(l);
      }
    }

    // ─── Step 3: Calculate average days in stage ───
    // For each stage, we look at leads CURRENTLY in that stage and calculate
    // how long they've been there (days since updated_at or created_at).
    // For "won"/"lost" we look at leads that reached that outcome.
    function calcAvgDaysInStage(stageKey: string, leadsInStage: PipelineLead[]): number {
      if (leadsInStage.length === 0) return 0;
      const now = new Date().getTime();
      let totalDays = 0;
      let count = 0;
      for (const l of leadsInStage) {
        const refDate = l.updated_at || l.created_at;
        if (!refDate) continue;
        const days = (now - new Date(refDate).getTime()) / 86_400_000;
        totalDays += days;
        count++;
      }
      return count > 0 ? Math.round((totalDays / count) * 10) / 10 : 0;
    }

    // ─── Step 4: Build funnel stages with metrics ───
    const topCount = stageCountMap[STAGE_DEFS[0].key] || 1; // "new" is top

    const stages = STAGE_DEFS.map((def, idx) => {
      const count = stageCountMap[def.key] || 0;
      const pctOfTop = topCount > 0 ? Math.round((count / topCount) * 100) : 0;
      const avgDaysInStage = calcAvgDaysInStage(def.key, stageLeads[def.key]);

      // Conversion rate to next stage
      const nextDef = STAGE_DEFS[idx + 1];
      let conversionToNext: number | null = null;
      if (nextDef && def.key !== "lost" && def.key !== "won") {
        const nextCount = stageCountMap[nextDef.key] || 0;
        conversionToNext = count > 0 ? Math.round((nextCount / count) * 100) : 0;
      }

      // Bottleneck: conversion < 30% to next stage (only for pipeline stages, not won/lost)
      const isBottleneck = conversionToNext !== null && conversionToNext < 30 && count > 3 && def.key !== "won" && def.key !== "lost";

      return {
        key: def.key,
        label: def.label,
        count,
        pctOfTop,
        conversionToNext,
        avgDaysInStage,
        isBottleneck,
      };
    });

    // ─── Step 5: Stuck leads — in a stage for > 2x average duration ───
    const stuckLeads: { id: string; customer_name: string | null; stage: string; days_in_stage: number; stage_label: string }[] = [];
    const now = new Date().getTime();
    for (const def of STAGE_DEFS) {
      if (def.key === "won" || def.key === "lost") continue;
      const avgDays = stages.find(s => s.key === def.key)?.avgDaysInStage || 1;
      const threshold = avgDays * 2;
      if (threshold <= 0) continue;

      for (const l of stageLeads[def.key] || []) {
        const refDate = l.updated_at || l.created_at;
        if (!refDate) continue;
        const daysInStage = (now - new Date(refDate).getTime()) / 86_400_000;
        if (daysInStage > threshold) {
          stuckLeads.push({
            id: l.id,
            customer_name: l.customer_name,
            stage: l.stage ?? def.key,
            days_in_stage: Math.round(daysInStage),
            stage_label: def.label,
          });
        }
      }
    }

    // Sort stuck leads by days_in_stage desc
    stuckLeads.sort((a, b) => b.days_in_stage - a.days_in_stage);

    // ─── Step 6: "Where I lose most" — for sales view, find the stage with the most leads lost ───
    const lostStage = stages.find(s => s.key === "lost");
    const lostCount = lostStage?.count || 0;
    let lostFromStage: Record<string, number> = {};
    // A lost lead's own stage is already "lost" (both loss paths set it), so the
    // stage it was lost from comes from its stage_change event (from -> lost).
    // Only the sales view (or a single rep) shows this block; management skips the event reads.
    if (lostCount > 0 && (!isManagement || userIdParam)) {
      const lostEvents = await fetchLostEvents(supabase, stageLeads.lost.map((lead) => lead.id));
      if (lostEvents.error) {
        console.error("[pipeline-funnel] Failed to fetch lost events:", lostEvents.error);
        return NextResponse.json({ error: "Failed to fetch leads" }, { status: 500 });
      }
      lostFromStage = lostFromStageCounts(lostEvents.data, stageLeads.lost.map((lead) => lead.id));
    }

    return NextResponse.json({
      stages,
      stuckLeads,
      totalLeads,
      lostFromStage,
    });
  } catch (err) {
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error ? err.message : "Unknown error";
    console.error("[pipeline-funnel] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
