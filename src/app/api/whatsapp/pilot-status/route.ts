// RBAC: active boss/admin, current session; metadata-only pilot visibility.
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse } from "@/lib/request-auth-context";
import { summarizeWhatsAppEvents, type PilotEvent } from "@/lib/whatsapp-pilot.mjs";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, status = 200) => applyRequestAuthCookies(context, NextResponse.json(body, { status }));
    if (!["admin", "boss"].includes(context.role)) return respond({ error: "forbidden" }, 403);
    const configured = Boolean(process.env.WHATSAPP_APP_SECRET && process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && process.env.WHATSAPP_PILOT_CONTACT_SALT);
    if (process.env.WHATSAPP_PILOT_ENABLED !== "true") return respond({ state: "disabled", configured, channels: [], conversations: [] });
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: channels, error: channelError } = await supabaseAdmin.from("whatsapp_pilot_channels")
      .select("id,label,purpose,enabled,accept_since").order("purpose");
    if (channelError) return respond({ error: "channel_lookup_failed" }, 503);
    const ids = (channels ?? []).filter(c => c.enabled).map(c => c.id);
    if (!ids.length) return respond({ state: "awaiting_channels", configured, channels: channels ?? [], conversations: [] });
    const { data: rows, error: eventError } = await supabaseAdmin.from("whatsapp_pilot_events")
      .select("channel_id,message_id,customer_key,direction,source,message_type,occurred_at,received_at")
      .in("channel_id", ids).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(1001);
    if (eventError) return respond({ error: "event_lookup_failed" }, 503);
    const truncated = (rows?.length ?? 0) > 1000;
    // Refuse to present partial response durations/counts as complete measurements.
    return respond({
      state: truncated ? "sample_limit" : (rows?.length ? "observing" : "awaiting_events"), configured,
      since, truncated, channels: channels ?? [],
      last_received_at: rows?.reduce<string | null>((last, row) => !last || row.received_at > last ? row.received_at : last, null) ?? null,
      conversations: truncated ? [] : summarizeWhatsAppEvents((rows ?? []) as PilotEvent[]),
      coverage: "handset_echoes_only_not_proof_of_employee_identity_or_complete_capture",
    });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "pilot_status_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
