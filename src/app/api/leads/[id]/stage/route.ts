// RBAC: authenticated lead owner, admin, or boss
import { NextRequest, NextResponse } from "next/server";
import { logger, genReqId } from "@/lib/logger";
import { createServerSupabase } from "@/lib/supabase-server";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";
import { evaluateFirstContactGate, isCompleteContact } from "@/lib/first-contact-gate.mjs";
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
  const request_id = genReqId();
  const { id: leadId } = await params;
  try {
    const profile = await getAuthProfile();
    if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const stage = String(body?.stage ?? "").trim();
    const note = String(body?.note ?? "").trim();
    if (note.length > 1000) {
      return NextResponse.json({ error: "Stage note must be 1000 characters or fewer" }, { status: 400 });
    }
    if (!note) {
      return NextResponse.json({ error: "Stage note is required" }, { status: 400 });
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

    const { data: contacts, error: contactsError } = await supabase
      .from("follow_up_logs")
      .select("contact_time, contact_result")
      .eq("lead_id", leadId);

    if (contactsError) {
      return NextResponse.json({ error: "Unable to verify contact records" }, { status: 500 });
    }

    const gate = evaluateFirstContactGate({
      currentStage: lead.stage,
      nextStage: stage,
      contactCount: (contacts ?? []).filter(isCompleteContact).length,
      quality: lead.quality,
    });
    if (!gate.allowed) {
      return NextResponse.json(
        { error: "First Contact requirements are incomplete", reasons: gate.reasons },
        { status: 409 },
      );
    }

    const { data: updated, error: updateError } = await supabase.rpc("transition_lead_stage", {
      p_lead_id: leadId,
      p_expected_stage: lead.stage,
      p_next_stage: stage,
      p_note: note,
    });

    if (updateError || !updated) {
      const message = updateError?.message ?? "Stage update failed";
      const status = message.includes("concurrently") ? 409
        : message.includes("Forbidden") ? 403
        : message.includes("not found") ? 404
        : 400;
      return NextResponse.json({ error: message }, { status });
    }

    return NextResponse.json({ success: true, lead: updated, eventLogged: true });
  } catch (error) {
    logger.error(
      {
        err: error,
        request_id,
        operation: "stage_transition",
        lead_id: leadId,
      },
      "stage route error",
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
