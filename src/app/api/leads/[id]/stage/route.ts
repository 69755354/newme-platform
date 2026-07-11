// RBAC: authenticated lead owner, admin, or boss
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";
import { evaluateFirstContactGate } from "@/lib/first-contact-gate.mjs";
import { PIPELINE_STAGES } from "@/shared/kanban/types";

const VALID_STAGES = new Set([
  ...PIPELINE_STAGES.map((stage) => stage.key),
  "won",
  "lost",
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const profile = await getAuthProfile();
    if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: leadId } = await params;
    const stage = String((await req.json())?.stage ?? "").trim();
    if (!VALID_STAGES.has(stage)) {
      return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
    }

    const supabase = await createServerSupabase();
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, assigned_to, stage, quality")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }
    if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
      return NextResponse.json({ error: "Forbidden: lead not assigned to you" }, { status: 403 });
    }

    const { count, error: countError } = await supabase
      .from("follow_up_logs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .not("contact_time", "is", null)
      .not("contact_result", "is", null)
      .neq("contact_result", "");

    if (countError) {
      return NextResponse.json({ error: "Unable to verify contact records" }, { status: 500 });
    }

    const gate = evaluateFirstContactGate({
      currentStage: lead.stage,
      nextStage: stage,
      contactCount: count ?? 0,
      quality: lead.quality,
    });
    if (!gate.allowed) {
      return NextResponse.json(
        { error: "First Contact requirements are incomplete", reasons: gate.reasons },
        { status: 409 },
      );
    }

    const update: Record<string, unknown> = {
      stage,
      stage_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (stage === "won" || stage === "lost") update.final_status = stage;

    let query = supabase
      .from("leads")
      .update(update)
      .eq("id", leadId)
      .eq("stage", lead.stage);
    if (!isAdminOrBoss(profile)) query = query.eq("assigned_to", profile.userId);

    const { data: updated, error: updateError } = await query
      .select("id, stage, final_status, quality, stage_changed_at, updated_at")
      .single();

    if (updateError || !updated) {
      return NextResponse.json(
        { error: updateError?.message ?? "Stage update failed" },
        { status: updateError?.code === "PGRST116" ? 409 : 400 },
      );
    }

    return NextResponse.json({ success: true, lead: updated });
  } catch (error) {
    console.error("stage route error", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
