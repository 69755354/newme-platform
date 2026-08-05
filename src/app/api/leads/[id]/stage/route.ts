// RBAC: authenticated lead owner, admin, or boss
import { NextRequest, NextResponse } from "next/server";
import { logger, genReqId } from "@/lib/logger";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";
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
    const context = await getRequestAuthContext(req);
    const { supabase } = context;
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));

    const body = await req.json();
    const stage = String(body?.stage ?? "").trim();
    const note = String(body?.note ?? "").trim();
    const idempotencyKey = String(body?.idempotencyKey ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return respond({ error: "A valid idempotency key is required" }, { status: 400 });
    }
    if (note.length > 1000) {
      return respond({ error: "Stage note must be 1000 characters or fewer" }, { status: 400 });
    }
    if (!note) {
      return respond({ error: "Stage note is required" }, { status: 400 });
    }
    if (!VALID_STAGES.has(stage)) {
      return respond({ error: "Invalid stage" }, { status: 400 });
    }

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, assigned_to, stage, quality")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      return respond({ error: "Lead not found" }, { status: 404 });
    }
    if (!lead.stage) {
      return respond({ error: "Lead stage is missing" }, { status: 409 });
    }
    if (!["admin", "boss", "operator"].includes(context.role) && lead.assigned_to !== context.user.id) {
      return respond({ error: "Forbidden: lead not assigned to you" }, { status: 403 });
    }

    const { data: contacts, error: contactsError } = await supabase
      .from("follow_up_logs")
      .select("contact_time, contact_result")
      .eq("lead_id", leadId);

    if (contactsError) {
      return respond({ error: "Unable to verify contact records" }, { status: 500 });
    }

    const gate = evaluateFirstContactGate({
      currentStage: lead.stage,
      nextStage: stage,
      contactCount: (contacts ?? []).filter(isCompleteContact).length,
      quality: lead.quality,
    });
    if (!gate.allowed) {
      return respond(
        { error: "First Contact requirements are incomplete", reasons: gate.reasons },
        { status: 409 },
      );
    }

    const { data: updated, error: updateError } = await supabase.rpc("transition_lead_stage", {
      p_lead_id: leadId,
      p_expected_stage: lead.stage,
      p_next_stage: stage,
      p_note: note,
      p_idempotency_key: idempotencyKey,
    });

    if (updateError || !updated) {
      const message = updateError?.message ?? "Stage update failed";
      const status = message.includes("concurrently") ? 409
        : message.includes("First Contact requirements") ? 409
        : message.includes("Forbidden") ? 403
        : message.includes("not found") ? 404
        : 400;
      return respond({ error: message }, { status });
    }

    return respond({ success: true, lead: updated, eventLogged: true });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
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
