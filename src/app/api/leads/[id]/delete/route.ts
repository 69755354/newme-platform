import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await getRequestAuthContext(req);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));
    const body = await req.json().catch(() => ({}));
    if (!UUID.test(body.idempotencyKey ?? "")) {
      return respond({ error: "A valid idempotency key is required", code: "INVALID_DELETE_REQUEST" }, { status: 400 });
    }
    const { id: leadId } = await params;
    const { data, error } = await context.supabase.rpc("delete_lead_atomic", {
      p_lead_id: leadId,
      p_idempotency_key: body.idempotencyKey,
    });
    if (error) {
      const message = error.message || "Lead delete failed";
      const status = message.includes("UNAUTHORIZED") ? 401
        : message.includes("FORBIDDEN") ? 403
        : message.includes("NOT_FOUND") ? 404
        : message.includes("BLOCKED") ? 409
        : 400;
      return respond({ error: message, code: message }, { status });
    }
    return respond({ success: true, result: data });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
