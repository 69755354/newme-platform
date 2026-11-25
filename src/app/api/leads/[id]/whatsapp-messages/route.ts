// RBAC: anyone who can see the lead under RLS (the lead is read with the caller's own identity first; service-role reads after)
// GET /api/leads/{id}/whatsapp-messages   the WhatsApp messages already stored for the lead (S43 / B12), oldest first
// Owner decision 2026-11-19: staff who can see a lead may read its conversation. Read-only; nothing is written.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import {
  applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse, type RequestAuthContext,
} from "@/lib/request-auth-context";

export const dynamic = "force-dynamic";
const MAX_MESSAGES = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WhatsAppMessageView {
  id: string;
  direction: "inbound" | "outbound";
  occurred_at: string;
  body: string | null;
  body_kind: string | null;
  message_type: string;
  backfilled: boolean;
}

/** Visible means RLS returned the row for the caller: the same boundary the lead page itself uses. */
async function canSeeLead(context: RequestAuthContext, leadId: string): Promise<boolean> {
  const { data, error } = await context.supabase.from("leads").select("id").eq("id", leadId).maybeSingle();
  return !error && Boolean(data?.id);
}

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store" } }));
    const leadId = (await route.params).id;
    if (!UUID.test(leadId)) return respond({ error: "Not found" }, { status: 404 });
    if (!(await canSeeLead(context, leadId))) return respond({ error: "Forbidden" }, { status: 403 });

    const { data: conversations, error: conversationError } = await supabaseAdmin
      .from("whatsapp_conversations").select("id").eq("lead_id", leadId);
    if (conversationError) throw new Error("conversation_query_failed");
    const ids = (conversations ?? []).map((row: { id: string }) => row.id);
    if (!ids.length) return respond({ has_conversation: false, messages: [] });

    // The newest MAX_MESSAGES, returned oldest first so the card reads like a chat.
    const { data: rows, error } = await supabaseAdmin.from("whatsapp_message_events")
      .select("id, direction, occurred_at, body, body_kind, message_type, backfilled")
      .in("conversation_id", ids).order("occurred_at", { ascending: false }).limit(MAX_MESSAGES);
    if (error) throw new Error("message_query_failed");
    const messages = ((rows ?? []) as WhatsAppMessageView[]).slice().reverse();
    return respond({ has_conversation: true, messages });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation: "lead_whatsapp_messages_read", code: error instanceof Error ? error.message : "unknown" }, "lead WhatsApp messages read failed");
    return NextResponse.json({ error: "Messages read failed" }, { status: 500 });
  }
}
