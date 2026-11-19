// RBAC: admin, boss, operator, or the lead's own sales owner (service-role reads after the role check)
// GET  /api/leads/{id}/followup              follow-up state of the lead and the fields suggested from the customer's messages
// POST /api/leads/{id}/followup {"action":"save_draft"}  write the suggested fields as one note draft (idempotent per content)
// The message text itself is never returned: only the follow-up numbers and the extracted suggestions.
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import {
  applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse, type RequestAuthContext,
} from "@/lib/request-auth-context";
import { buildFieldDraftNote, extractLeadFields } from "@/lib/whatsapp-field-extract.mjs";

export const dynamic = "force-dynamic";
const MAX_MESSAGES = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAFF_ROLES = new Set(["admin", "boss", "operator"]);

async function authorize(context: RequestAuthContext, leadId: string): Promise<boolean> {
  if (STAFF_ROLES.has(context.role)) return true;
  if (context.role !== "sales") return false;
  const { data } = await context.supabase.from("leads").select("assigned_to").eq("id", leadId).maybeSingle();
  return data?.assigned_to === context.user.id;
}

async function suggestions(leadId: string) {
  const { data: conversations, error: conversationError } = await supabaseAdmin.from("whatsapp_conversations").select("id").eq("lead_id", leadId);
  if (conversationError) throw new Error("conversation_query_failed");
  const ids = (conversations ?? []).map((row: { id: string }) => row.id);
  if (!ids.length) return { conversations: 0, extraction: { fields: [] as ReturnType<typeof extractLeadFields>["fields"] } };
  const { data: messages, error } = await supabaseAdmin.from("whatsapp_message_events")
    .select("message_id, direction, body").in("conversation_id", ids).eq("direction", "inbound").not("body", "is", null)
    .order("occurred_at", { ascending: true }).limit(MAX_MESSAGES);
  if (error) throw new Error("message_query_failed");
  return {
    conversations: ids.length,
    extraction: extractLeadFields((messages ?? []).map((m: { message_id: string; direction: "inbound"; body: string }) => ({ id: m.message_id, text: m.body, direction: m.direction }))),
  };
}

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) => applyRequestAuthCookies(context, NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store" } }));
    const leadId = (await route.params).id;
    if (!UUID.test(leadId)) return respond({ error: "Not found" }, { status: 404 });
    if (!(await authorize(context, leadId))) return respond({ error: "Forbidden" }, { status: 403 });
    const [{ data: state, error: stateError }, found] = await Promise.all([
      supabaseAdmin.from("lead_followup_state")
        .select("first_inbound_at, first_reply_at, first_response_minutes, contact_count_5wd, last_outbound_at, state, state_since, abandon_risk, updated_at")
        .eq("lead_id", leadId).maybeSingle(),
      suggestions(leadId),
    ]);
    if (stateError) throw new Error("state_query_failed");
    return respond({ has_conversation: found.conversations > 0, state: state ?? null, fields: found.extraction.fields });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation: "lead_followup_read", code: error instanceof Error ? error.message : "unknown" }, "lead follow-up read failed");
    return NextResponse.json({ error: "Follow-up read failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) => applyRequestAuthCookies(context, NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store" } }));
    const leadId = (await route.params).id;
    if (!UUID.test(leadId)) return respond({ error: "Not found" }, { status: 404 });
    if (!(await authorize(context, leadId))) return respond({ error: "Forbidden" }, { status: 403 });
    let body: { action?: string } = {};
    try { body = await request.json(); } catch { /* the action check below answers */ }
    if (body.action !== "save_draft") return respond({ error: "invalid_request" }, { status: 400 });
    const { extraction } = await suggestions(leadId);
    const note = buildFieldDraftNote(extraction);
    if (!note) return respond({ saved: false, reason: "nothing_to_suggest" });
    // The key is the content hash: saving the same suggestions twice writes one note.
    const key = `field-draft:${createHash("sha256").update(note).digest("hex").slice(0, 24)}`;
    const { data: existing, error: existingError } = await supabaseAdmin.from("activities").select("id").eq("lead_id", leadId).eq("metadata->>key", key).limit(1);
    if (existingError) throw new Error("draft_lookup_failed");
    if ((existing ?? []).length) return respond({ saved: false, reason: "already_saved" });
    const { error } = await supabaseAdmin.from("activities").insert({
      lead_id: leadId, user_id: context.user.id, type: "note", content: note, ai_generated: false, is_completed: true,
      metadata: { source: "whatsapp_field_extract", key, draft: true },
    });
    if (error) throw new Error("draft_write_failed");
    return respond({ saved: true });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation: "lead_followup_draft", code: error instanceof Error ? error.message : "unknown" }, "lead follow-up draft failed");
    return NextResponse.json({ error: "Draft failed" }, { status: 500 });
  }
}
