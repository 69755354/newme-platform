// RBAC: authenticated lead owner, admin, or boss
import { NextRequest, NextResponse } from "next/server";
import { logger, genReqId } from "@/lib/logger";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

const METHODS = new Set(["phone", "whatsapp", "other"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> },
) {
  const request_id = genReqId();
  const { id: leadId, contactId } = await params;
  try {
    const context = await getRequestAuthContext(req);
    const { supabase } = context;
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));

    const body = await req.json();
    const contactMethod = String(body?.contact_method ?? "").trim().toLowerCase();
    const contactResult = String(body?.contact_result ?? "").trim();
    const summary = String(body?.summary ?? "").trim();
    const contactTime = new Date(String(body?.contact_time ?? ""));

    if (!METHODS.has(contactMethod)) {
      return respond({ error: "Invalid contact_method" }, { status: 400 });
    }
    if (Number.isNaN(contactTime.getTime())) {
      return respond({ error: "Invalid contact_time" }, { status: 400 });
    }
    if (contactTime.getTime() > Date.now()) {
      return respond({ error: "contact_time cannot be in the future" }, { status: 400 });
    }
    if (!contactResult) {
      return respond({ error: "contact_result is required" }, { status: 400 });
    }

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, assigned_to")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      return respond({ error: "Lead not found" }, { status: 404 });
    }
    if (!["admin", "boss", "operator"].includes(context.role) && lead.assigned_to !== context.user.id) {
      return respond({ error: "Forbidden: lead not assigned to you" }, { status: 403 });
    }

    // follow_up_logs is intentionally immutable through client RLS. After the
    // explicit auth/ownership checks above, use the server-only admin client for
    // this narrowly scoped correction and immediately read the stored row back.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("follow_up_logs")
      .update({
        contact_type: contactMethod,
        contact_time: contactTime.toISOString(),
        contact_result: contactResult,
        summary,
      })
      .eq("id", contactId)
      .eq("lead_id", leadId)
      .select("id, lead_id, contact_type, contact_time, contact_result, summary, user_id, created_at")
      .single();

    if (updateError || !updated) {
      return respond(
        { error: updateError?.message ?? "Contact record not found" },
        { status: updateError?.code === "PGRST116" ? 404 : 400 },
      );
    }

    return respond({ success: true, contact: updated });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error(
      {
        err: error,
        request_id,
        operation: "contact_update",
        lead_id: leadId,
        contact_id: contactId,
      },
      "contact update route error",
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> },
) {
  const request_id = genReqId();
  const { id: leadId, contactId } = await params;
  try {
    const context = await getRequestAuthContext(req);
    const { supabase } = context;
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, assigned_to")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) return respond({ error: "Lead not found" }, { status: 404 });
    if (!["admin", "boss", "operator"].includes(context.role) && lead.assigned_to !== context.user.id) {
      return respond({ error: "Forbidden: lead not assigned to you" }, { status: 403 });
    }

    const { data: contact, error: contactError } = await supabaseAdmin
      .from("follow_up_logs")
      .select("id, contact_type")
      .eq("id", contactId)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (contactError || !contact) return respond({ error: "Contact record not found" }, { status: 404 });
    if (["note", "import_note"].includes(contact.contact_type)) {
      return respond({ error: "Notes cannot be deleted as contact records" }, { status: 403 });
    }

    const { error: deleteError } = await supabaseAdmin
      .from("follow_up_logs")
      .delete()
      .eq("id", contactId)
      .eq("lead_id", leadId);
    if (deleteError) return respond({ error: deleteError.message }, { status: 400 });

    return respond({ success: true, id: contactId });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error(
      {
        err: error,
        request_id,
        operation: "contact_delete",
        lead_id: leadId,
        contact_id: contactId,
      },
      "contact delete route error",
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
