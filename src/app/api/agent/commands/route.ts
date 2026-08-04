import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import { getRequestedOrganizationId } from "@/lib/organization-context";
import {
  AgentGatewayError,
  buildAgentGatewayDispatch,
} from "@/lib/agent-gateway";
import { supabaseAdmin } from "@/lib/supabase-admin";

function errorResponse(error: unknown) {
  if (error instanceof RequestAuthError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof AgentGatewayError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: "agent_gateway_unavailable" }, { status: 503 });
}

function rpcStatus(message: string): number {
  if (message.includes("agent_gateway_l4_denied")) return 403;
  if (message.includes("agent_gateway_capability_required")
    || message.includes("agent_gateway_actor_inactive")
    || message.includes("agent_gateway_organization_unavailable")) return 403;
  if (message.includes("agent_gateway_")) return 400;
  return 503;
}

export async function POST(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const organizationId = getRequestedOrganizationId(request);
    if (!organizationId) {
      return applyRequestAuthCookies(
        context,
        NextResponse.json({ error: "organization_context_required" }, { status: 400 }),
      );
    }
    const dispatch = buildAgentGatewayDispatch({
      actorUserId: context.user.id,
      organizationId,
      input: await request.json().catch(() => null),
    });
    // The only privileged operation is this constrained SECURITY DEFINER RPC.
    // The gateway never exposes a service-role client or a direct table write to
    // a browser, agent, or adapter.
    const { data, error } = await supabaseAdmin.rpc(
      "v4_dispatch_agent_gateway_command",
      {
        p_actor_user_id: dispatch.actorUserId,
        p_organization_id: dispatch.organizationId,
        p_command_key: dispatch.commandKey,
        p_risk_level: dispatch.riskLevel,
        p_required_capability: dispatch.requiredCapability,
        p_access_mode: dispatch.accessMode,
        p_channel: dispatch.channel,
        p_correlation_id: dispatch.correlationId,
        p_idempotency_key: dispatch.idempotencyKey,
        p_payload: dispatch.payload,
        p_payload_sha256: dispatch.payloadSha256,
        p_event_signature: dispatch.eventSignature,
        p_credential_fingerprint: dispatch.credentialFingerprint,
        p_credential_expires_at: dispatch.credentialExpiresAt,
      },
    );
    if (error || !data) {
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "agent_gateway_dispatch_failed" },
          { status: rpcStatus(error?.message ?? "") },
        ),
      );
    }
    const body = data as Record<string, unknown>;
    const denied = body.status === "denied";
    return applyRequestAuthCookies(
      context,
      NextResponse.json(body, {
        status: denied ? 403 : body.status === "approval_required" ? 202 : 200,
        headers: { "Cache-Control": "no-store" },
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
