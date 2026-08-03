// RBAC: platform_owner/platform_ops may request; a second authenticated staff approves.
import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import type { Json } from "@/types/database";

type Body = Record<string, unknown>;

function objectBody(value: unknown): Body | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Body
    : null;
}

function text(body: Body, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rpcStatus(message: string): number {
  if (message.includes("permission_required") || message.includes("platform_staff_required")) {
    return 403;
  }
  if (message.includes("not_found")) return 404;
  if (message.includes("payload_mismatch") || message.includes("target_mismatch")) return 409;
  if (message.includes("invalid_") || message.includes("required")) return 400;
  return 503;
}

async function requestApproval(
  request: NextRequest,
  actionKey: string,
  targetKey: string,
  payload: Json,
  requestId: string,
) {
  const context = await getRequestAuthContext(request);
  const { data, error } = await context.supabase.rpc(
    "v4_request_platform_action_approval",
    {
      p_action_key: actionKey,
      p_target_key: targetKey,
      p_payload: payload,
      p_request_id: requestId,
    },
  );
  if (error || !data) {
    const message = error?.message ?? "platform_approval_request_unavailable";
    return applyRequestAuthCookies(
      context,
      NextResponse.json(
        { error: "platform_approval_request_unavailable" },
        { status: rpcStatus(message) },
      ),
    );
  }
  return applyRequestAuthCookies(
    context,
    NextResponse.json(data, { status: 202, headers: { "Cache-Control": "no-store" } }),
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = objectBody(await request.json().catch(() => null));
    if (!body || "approver_user_id" in body) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const ownerUserId = text(body, "owner_user_id");
    const idempotencyKey = text(body, "idempotency_key");
    const slug = text(body, "slug")?.toLowerCase() ?? null;
    const name = text(body, "name");
    const industryKey = text(body, "industry_key");
    const planKey = text(body, "plan_key");
    const seatLimit = body.billable_seat_limit;
    if (!ownerUserId || !idempotencyKey || !slug || !name
      || !industryKey || !planKey || typeof seatLimit !== "number"
      || !Number.isSafeInteger(seatLimit)) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    return await requestApproval(
      request,
      "organization.provision",
      slug,
      {
        slug,
        name,
        industry_key: industryKey,
        plan_key: planKey,
        billable_seat_limit: seatLimit,
        owner_user_id: ownerUserId,
      },
      idempotencyKey,
    );
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "platform_approval_request_unavailable" }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = objectBody(await request.json().catch(() => null));
    if (!body || "approver_user_id" in body) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const organizationId = text(body, "organization_id");
    const action = text(body, "action");
    const reason = text(body, "reason");
    const idempotencyKey = text(body, "idempotency_key");
    if (!organizationId || !reason || !idempotencyKey
      || !["suspend", "recover"].includes(action ?? "")) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    return await requestApproval(
      request,
      `organization.${action}`,
      organizationId,
      { organization_id: organizationId, action: action!, reason },
      idempotencyKey,
    );
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "platform_approval_request_unavailable" }, { status: 503 });
  }
}
