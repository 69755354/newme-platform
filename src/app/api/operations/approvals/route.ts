import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { boundedLimit, errorResponse, isUuid, jsonResponse, parseObject, text } from "@/lib/shared-operations";
import type { Json } from "@/types/database";

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.operations.read");
    const { data, error } = await access.context.supabase.from("shared_approval_requests").select("*")
      .eq("organization_id", access.organizationId).order("created_at", { ascending: false })
      .limit(boundedLimit(request));
    if (error) throw error;
    return jsonResponse(access, { data: data ?? [] });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.approvals.request", "write");
    const body = parseObject(await request.json().catch(() => null));
    const action = text(body?.action_key, 96);
    const resourceType = text(body?.resource_type, 64);
    const idempotencyKey = text(body?.idempotency_key, 160);
    if (!body || !action || !resourceType || !idempotencyKey || !isUuid(body.resource_id)) {
      return errorResponse(new Error("shared_approval_invalid"));
    }
    const payload = parseObject(body.payload) ?? {};
    const { data, error } = await access.context.supabase.rpc("v4_request_shared_approval", {
      p_organization_id: access.organizationId, p_action_key: action,
      p_resource_type: resourceType, p_resource_id: body.resource_id,
      p_payload: payload as Json,
      p_expires_at: typeof body.expires_at === "string"
        ? body.expires_at : new Date(Date.now() + 86_400_000).toISOString(),
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    return jsonResponse(access, { data }, 201);
  } catch (error) { return errorResponse(error); }
}
