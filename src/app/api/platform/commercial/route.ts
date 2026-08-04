// SAM-79: platform commercial administration with independent approval.
import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { Json } from "@/types/database";

type Body = Record<string, unknown>;

function objectBody(value: unknown): Body | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Body
    : null;
}

function text(body: Body, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

function rpcStatus(message: string): number {
  if (message.includes("permission") || message.includes("platform_staff")) return 403;
  if (message.includes("not_found")) return 404;
  if (message.includes("expired") || message.includes("idempotency")
    || message.includes("independent") || message.includes("limit")) return 409;
  if (message.includes("invalid") || message.includes("required")) return 400;
  return 503;
}

export async function GET(request: NextRequest) {
  try {
    const organizationId = request.nextUrl.searchParams.get("organization_id")?.trim() ?? "";
    if (!organizationId) {
      return NextResponse.json({ error: "organization_id_required" }, { status: 400 });
    }
    const context = await getRequestAuthContext(request);
    const { data, error } = await context.supabase.rpc(
      "v4_get_commercial_summary",
      { p_organization_id: organizationId },
    );
    if (error || !data) {
      const message = error?.message ?? "commercial_summary_unavailable";
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "commercial_summary_unavailable" },
          { status: rpcStatus(message), headers: { "Cache-Control": "no-store" } },
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
    return NextResponse.json({ error: "commercial_summary_unavailable" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const body = objectBody(await request.json().catch(() => null));
    if (!body || "actor_user_id" in body || "approver_user_id" in body) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const organizationId = text(body, "organization_id");
    const actionKey = text(body, "action_key");
    const requestKey = text(body, "request_key");
    const payload = objectBody(body.payload);
    if (!organizationId || !actionKey || requestKey.length < 8 || !payload) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const { data, error } = await context.supabase.rpc(
      "v4_request_commercial_action",
      {
        p_organization_id: organizationId,
        p_action_key: actionKey,
        p_payload: payload as Json,
        p_request_key: requestKey,
      },
    );
    if (error || !data) {
      const message = error?.message ?? "commercial_action_request_failed";
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "commercial_action_request_failed" },
          { status: rpcStatus(message) },
        ),
      );
    }
    return applyRequestAuthCookies(
      context,
      NextResponse.json(data, {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      }),
    );
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "commercial_action_request_failed" }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const body = objectBody(await request.json().catch(() => null));
    if (!body || "actor_user_id" in body || "approver_user_id" in body) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const requestId = text(body, "request_id");
    const approvalKey = text(body, "approval_key");
    const executionKey = text(body, "execution_key");
    if (!requestId || approvalKey.length < 8 || executionKey.length < 8) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const { error: approvalError } = await context.supabase.rpc(
      "v4_approve_commercial_action",
      { p_request_id: requestId, p_event_key: approvalKey },
    );
    if (approvalError) {
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "commercial_action_approval_failed" },
          { status: rpcStatus(approvalError.message) },
        ),
      );
    }
    const { data, error: executionError } = await supabaseAdmin.rpc(
      "v4_execute_commercial_action",
      { p_request_id: requestId, p_execution_key: executionKey },
    );
    if (executionError || !data) {
      const message = executionError?.message ?? "commercial_action_execution_failed";
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "commercial_action_execution_failed" },
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
    return NextResponse.json({ error: "commercial_action_execution_failed" }, { status: 503 });
  }
}
