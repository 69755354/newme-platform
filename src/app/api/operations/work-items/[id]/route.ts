import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { errorResponse, isUuid, jsonResponse, parseObject, text } from "@/lib/shared-operations";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.work.write", "write");
    const { id } = await params;
    const body = parseObject(await request.json().catch(() => null));
    const status = text(body?.status, 20);
    if (!isUuid(id) || !body || Object.keys(body).length !== 1 || !status) {
      return errorResponse(new Error("shared_work_item_invalid"));
    }
    const { data, error } = await access.context.supabase.rpc("v4_transition_shared_work_item", {
      p_organization_id: access.organizationId, p_work_item_id: id, p_status: status,
    });
    if (error) throw error;
    return jsonResponse(access, { data });
  } catch (error) { return errorResponse(error); }
}
