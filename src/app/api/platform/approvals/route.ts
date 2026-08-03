// RBAC: platform_owner/platform_ops; requester and approver are auth.uid()-bound.
import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Body = Record<string, unknown>;

function rpcStatus(message: string): number {
  if (message.includes("permission_required")
    || message.includes("platform_staff_required")
    || message.includes("independent_platform_approver_required")) return 403;
  if (message.includes("not_found")) return 404;
  if (message.includes("expired") || message.includes("already_")
    || message.includes("approved_platform_action_required")) return 409;
  if (message.includes("invalid_") || message.includes("required")) return 400;
  return 503;
}

export async function PATCH(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const parsed = await request.json().catch(() => null);
    const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Body
      : null;
    const approvalId = typeof body?.approval_request_id === "string"
      ? body.approval_request_id.trim()
      : "";
    const consumptionKey = typeof body?.consumption_key === "string"
      ? body.consumption_key.trim()
      : "";
    if (!body || Object.keys(body).length !== 2 || !approvalId
      || consumptionKey.length < 8 || "approver_user_id" in body) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const { error: approvalError } = await context.supabase.rpc(
      "v4_approve_platform_action",
      {
        p_approval_request_id: approvalId,
        p_request_id: context.requestId,
      },
    );
    if (approvalError) {
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "platform_action_approval_failed" },
          { status: rpcStatus(approvalError.message) },
        ),
      );
    }
    const { data, error: executionError } = await supabaseAdmin.rpc(
      "v4_execute_approved_platform_action",
      {
        p_approval_request_id: approvalId,
        p_consumption_key: consumptionKey,
      },
    );
    if (executionError || !data) {
      const message = executionError?.message ?? "platform_action_execution_failed";
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "platform_action_execution_failed" },
          { status: rpcStatus(message) },
        ),
      );
    }
    return applyRequestAuthCookies(
      context,
      NextResponse.json(data, { headers: { "Cache-Control": "no-store" } }),
    );
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "platform_action_execution_failed" }, { status: 503 });
  }
}
