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
import { supabaseAdmin } from "@/lib/supabase-admin";
import { enqueueMetaCrmFunnelBetween } from "@/lib/meta-crm-events";
import { stageErrorZh, stageReasonsZh } from "@/lib/stage-error-zh.mjs";
import { ensureWonAmount, revertWonAmount } from "@/lib/won-amount.mjs";
import { enqueueWhatsAppPurchaseForLead } from "@/lib/whatsapp-capi.mjs";
import { enqueueWebsitePurchaseForLead, enqueueWebsiteQuoteForProgress, enqueueWhatsAppProgressWithDelivery } from "@/lib/website-capi-valued";

const VALID_STAGES = new Set([
  ...PIPELINE_STAGES.map((stage) => stage.key),
  "won",
  "lost",
]);

// Every rejection also carries its Chinese wording (error_zh, reasons_zh) so the Chinese screens never show raw English.
function withChineseError(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.error !== "string") return body;
  return {
    ...body,
    error_zh: typeof body.error_zh === "string" ? body.error_zh : stageErrorZh(body.error),
    ...(Array.isArray(body.reasons) ? { reasons_zh: stageReasonsZh(body.reasons) } : {}),
  };
}

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
      applyRequestAuthCookies(context, NextResponse.json(withChineseError(body), init));

    const body = await req.json();
    const stage = String(body?.stage ?? "").trim();
    let note = String(body?.note ?? "").trim();
    const idempotencyKey = String(body?.idempotencyKey ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return respond({ error: "A valid idempotency key is required" }, { status: 400 });
    }
    if (note.length > 1000) {
      return respond({ error: "Stage note must be 1000 characters or fewer" }, { status: 400 });
    }
    if (!VALID_STAGES.has(stage)) {
      return respond({ error: "Invalid stage" }, { status: 400 });
    }
    // S39: a note is optional for a move along the funnel; won (the amount's story) and lost (the reason) still need one.
    if (!note && (stage === "won" || stage === "lost")) {
      return respond({ error: "Stage note is required" }, { status: 400 });
    }
    if (!note) note = `Stage set to ${stage}`;

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, assigned_to, stage, quality, quotation_value")
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
      quality: lead.quality, // S39: no longer part of the rule
    });
    if (!gate.allowed) {
      return respond(
        { error: "First Contact requirements are incomplete", reasons: gate.reasons },
        { status: 409 },
      );
    }

    // A deal can only be won with an amount: the active contract's, else the latest quotation's, else the one typed in
    // the same dialog (body.amount). A typed amount is stored first, so the contract the won trigger creates, the KPIs
    // and the Won / Purchase events to Meta all carry it. An idempotent replay of an already-won lead has one already.
    let wroteAmount = false;
    let writtenAmount = 0;
    if (stage === "won") {
      const won = await ensureWonAmount(supabaseAdmin, leadId, body?.amount);
      if (!won.ok) {
        return respond(
          { error: won.error, error_zh: won.error_zh, code: won.code },
          { status: won.code === "won_amount_required" ? 409 : 500 },
        );
      }
      wroteAmount = won.wrote;
      writtenAmount = won.amount.value;
    }

    const { data: updated, error: updateError } = await supabase.rpc("transition_lead_stage", {
      p_lead_id: leadId,
      p_expected_stage: lead.stage,
      p_next_stage: stage,
      p_note: note,
      p_idempotency_key: idempotencyKey,
    });

    if (updateError || !updated) {
      // The lead did not become won: take the typed amount back out so nothing half-saved is left behind. Conditional:
      // only while the row still holds exactly what this request wrote and the lead is not won, so a concurrent request
      // that did win the lead (or a newer quotation value) is never wiped.
      if (wroteAmount) await revertWonAmount(supabaseAdmin, leadId, writtenAmount, lead.quotation_value ?? null);
      const message = updateError?.message ?? "Stage update failed";
      const status = message.includes("concurrently") ? 409
        : message.includes("First Contact requirements") ? 409
        : message.includes("Forbidden") ? 403
        : message.includes("not found") ? 404
        : 400;
      return respond({ error: message }, { status });
    }

    // A lost lead keeps its reason (the note) in leads.lost_reason so the detail page shows it; set only while empty, best effort.
    if (stage === "lost" && (updated as { idempotent_replay?: unknown })?.idempotent_replay !== true) {
      try { await supabaseAdmin.from("leads").update({ lost_reason: note.slice(0, 1000) }).eq("id", leadId).is("lost_reason", null); }
      catch { /* the stage change already committed; the note is also in the audit trail */ }
    }

    // Meta CRM feedback is best-effort and queued server-side; it never blocks
    // or fails a salesperson's stage change.
    // The column is read separately and tolerantly so this route keeps working
    // before the optional Meta CRM schema exists.
    try {
      const { data: tag, error: tagError } = await supabaseAdmin.from("leads")
        .select("meta_leadgen_id").eq("id", leadId).maybeSingle();
      // Derive the event from the committed RPC result, not the request: an
      // idempotent replay returns the cached earlier transition unchanged.
      const committed = (updated && typeof updated === "object" && !Array.isArray(updated))
        ? updated as { id?: unknown; stage?: unknown; idempotent_replay?: unknown }
        : null;
      const committedStage = committed && committed.idempotent_replay !== true
        && (committed.id === undefined || committed.id === leadId)
        && typeof committed.stage === "string" ? committed.stage : null;
      if (!tagError && tag?.meta_leadgen_id && committedStage === stage) {
        // S39: a skipped stage still reports every funnel step passed on the way.
        await enqueueMetaCrmFunnelBetween(supabaseAdmin, { id: leadId, meta_leadgen_id: tag.meta_leadgen_id }, lead.stage, committedStage);
      }
      // Click-to-WhatsApp leads report to the business-messaging dataset instead.
      if (committedStage && committedStage === stage) {
        if (committedStage === "won") {
          await enqueueWhatsAppPurchaseForLead(supabaseAdmin, leadId);
          await enqueueWebsitePurchaseForLead(supabaseAdmin, leadId);
        }
        else {
          await enqueueWhatsAppProgressWithDelivery(supabaseAdmin, leadId, committedStage);
          await enqueueWebsiteQuoteForProgress(supabaseAdmin, leadId, committedStage);
        }
      }
    } catch { /* tracking must never fail a stage change */ }

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
    return NextResponse.json({ error: "Internal server error", error_zh: stageErrorZh("Internal server error") }, { status: 500 });
  }
}
