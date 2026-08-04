import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { errorResponse, isUuid, jsonResponse, parseObject, text } from "@/lib/shared-operations";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.approvals.decide", "write");
    const { id } = await params;
    const body = parseObject(await request.json().catch(() => null));
    const decision = text(body?.decision, 16);
    const reason = text(body?.reason_code, 96);
    if (!isUuid(id) || !body || !decision || !reason) return errorResponse(new Error("shared_approval_invalid"));
    const { data, error } = await access.context.supabase.rpc("v4_decide_shared_approval", {
      p_organization_id: access.organizationId, p_approval_id: id,
      p_decision: decision, p_reason_code: reason,
    });
    if (error) throw error;
    return jsonResponse(access, { data });
  } catch (error) { return errorResponse(error); }
}
