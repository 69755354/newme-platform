import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  type RequestAuthContext,
} from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseSupportSessionApprovalRequest } from "@/lib/support-session-approval-request";

type JsonObject = Record<string, unknown>;

const CALLER_ERRORS = new Map<string, number>([
  ["platform_staff_required", 403],
  ["independent_support_approver_required", 403],
  ["support_session_not_authorized", 403],
  ["active_support_organization_required", 404],
  ["support_ticket_ref_required", 400],
  ["support_reason_required", 400],
  ["support_request_id_required", 400],
  ["support_scope_invalid", 400],
  ["support_expiry_invalid", 400],
  ["support_session_not_active", 409],
]);

function response(
  context: RequestAuthContext,
  body: JsonObject,
  status: number,
): NextResponse {
  return applyRequestAuthCookies(
    context,
    NextResponse.json(body, { status }),
  );
}

function bodyObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function requiredString(body: JsonObject, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function supportError(error: unknown): { code: string; status: number } {
  const message = error !== null
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
    ? error.message
    : "";
  for (const [code, status] of CALLER_ERRORS) {
    if (message.includes(code)) return { code, status };
  }
  return { code: "support_session_unavailable", status: 503 };
}

function approvalStatus(message: string): number {
  for (const [code, status] of CALLER_ERRORS) {
    if (message.includes(code)) return status;
  }
  if (message.includes("permission_required")
    || message.includes("platform_staff_required")) return 403;
  if (message.includes("not_found")
    || message.includes("active_support_organization_required")) return 404;
  if (message.includes("payload_mismatch")
    || message.includes("target_mismatch")) return 409;
  if (message.includes("invalid_") || message.includes("required")) return 400;
  return 503;
}

async function authContext(request: NextRequest) {
  try {
    return {
      context: await getRequestAuthContext(request),
      error: null,
    };
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return {
        context: null,
        error: NextResponse.json(
          { error: error.code },
          { status: error.status },
        ),
      };
    }
    return {
      context: null,
      error: NextResponse.json(
        { error: "auth_unavailable" },
        { status: 503 },
      ),
    };
  }
}

export async function POST(request: NextRequest) {
  const auth = await authContext(request);
  if (!auth.context) return auth.error;
  const context = auth.context;

  const input = parseSupportSessionApprovalRequest(
    await request.json().catch(() => null),
  );
  if (!input) {
    return response(context, { error: "invalid_request" }, 400);
  }
  const { data, error } = await context.supabase.rpc(
    "v4_request_platform_action_approval",
    {
      p_action_key: "support.session.start",
      p_target_key: input.organizationId,
      p_payload: input.payload,
      p_request_id: input.idempotencyKey,
    },
  );
  if (error || !data) {
    const message = error?.message ?? "support_approval_request_unavailable";
    return response(
      context,
      { error: "support_approval_request_unavailable" },
      approvalStatus(message),
    );
  }

  return applyRequestAuthCookies(
    context,
    NextResponse.json(data, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    }),
  );
}

export async function DELETE(request: NextRequest) {
  const auth = await authContext(request);
  if (!auth.context) return auth.error;
  const context = auth.context;

  const body = bodyObject(await request.json().catch(() => null));
  const supportSessionId = body
    ? requiredString(body, "support_session_id")
    : null;
  if (!supportSessionId) {
    return response(context, { error: "invalid_request" }, 400);
  }

  const { data, error } = await supabaseAdmin.rpc(
    "end_support_session_atomic",
    {
      p_actor_user_id: context.user.id,
      p_support_session_id: supportSessionId,
      p_request_id: context.requestId,
    },
  );
  if (error || data !== true) {
    const mapped = supportError(error);
    return response(context, { error: mapped.code }, mapped.status);
  }

  return response(
    context,
    {
      support_session_id: supportSessionId,
      status: "revoked",
    },
    200,
  );
}
