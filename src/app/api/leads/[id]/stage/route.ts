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
    const body = await req.json();
    const stage = String(body?.stage ?? "").trim();
    const note = String(body?.note ?? "").trim();
    if (note.length > 1000) {
      return NextResponse.json({ error: "Stage note must be 1000 characters or fewer" }, { status: 400 });
    }
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

    // Preserve the existing analytics/audit contract used by weekly-review.
    // The previous client updateField path wrote this event after the lead row.
    const { error: eventError } = await supabase.from("business_events").insert({
      lead_id: leadId,
      user_id: profile.userId,
      event_type: "stage_change",
      description: note
        ? `Stage changed from ${lead.stage} to ${stage}: ${note}`
        : `Stage changed from ${lead.stage} to ${stage}`,
      event_data: { from: lead.stage, to: stage, ...(note ? { note } : {}) },
      created_at: new Date().toISOString(),
    });
    if (eventError) {
      console.error("stage_change audit insert failed", eventError);
    }

    return NextResponse.json({
      success: true,
      lead: updated,
      eventLogged: !eventError,
      ...(eventError && process.env.NODE_ENV !== "production"
        ? { eventError: eventError.message }
        : {}),
    });
  } catch (error) {
    console.error("stage route error", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
