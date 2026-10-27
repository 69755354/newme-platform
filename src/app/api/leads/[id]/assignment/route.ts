import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import { isLeadUpdatedAtToken } from "@/lib/lead-transfer-batch.mjs";

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await getRequestAuthContext(req);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));
    if (!["admin", "boss", "operator"].includes(context.role)) {
      return respond({ error: "Forbidden", code: "FORBIDDEN_REASSIGNMENT" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    if (!validUuid(body.assignedTo) || !validUuid(body.idempotencyKey)) {
      return respond({ error: "assignedTo and idempotencyKey must be UUIDs", code: "INVALID_REQUEST" }, { status: 400 });
    }
    // R6. reassign_lead_atomic() only compares when p_expected_updated_at is not
    // null, so `?? null` here was a way to switch the compare-and-set off by
    // leaving a field out of the body — no error, no comparison, and whoever
    // reassigned the lead in the meantime is overwritten. The token is required.
    // Both callers already send it (useLeadMutations.ts:145 and
    // useLeadDetailMutations.ts:166, from rows that select updated_at), so the
    // only request this refuses is one that was skipping the check.
    if (!isLeadUpdatedAtToken(body.expectedUpdatedAt)) {
      return respond(
        { error: "expectedUpdatedAt must be the lead's current updated_at", code: "INVALID_REQUEST" },
        { status: 400 }
      );
    }
    const expectedUpdatedAt = body.expectedUpdatedAt;
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "manual_reassign";
    const { id: leadId } = await params;
    const { data, error } = await context.supabase.rpc("reassign_lead_atomic", {
      p_lead_id: leadId,
      p_new_assignee: body.assignedTo,
      p_expected_updated_at: expectedUpdatedAt,
      p_idempotency_key: body.idempotencyKey,
      p_reason: reason,
    });

    if (error) {
      const message = error.message || "Lead reassignment failed";
      const status = message.includes("UNAUTHORIZED") ? 401
        : message.includes("FORBIDDEN") ? 403
        : message.includes("NOT_FOUND") ? 404
        : message.includes("CONCURRENT") ? 409
        : 400;
      return respond({ error: message, code: message }, { status });
    }
    return respond({ success: true, result: data });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
