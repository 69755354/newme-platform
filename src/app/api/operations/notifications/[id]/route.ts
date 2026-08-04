import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { errorResponse, isUuid, jsonResponse } from "@/lib/shared-operations";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.operations.read", "read");
    const { id } = await params;
    if (!isUuid(id)) return errorResponse(new Error("shared_notification_invalid"));
    const { data, error } = await access.context.supabase.rpc("v4_mark_shared_notification_read", {
      p_organization_id: access.organizationId, p_notification_id: id,
    });
    if (error) throw error;
    return jsonResponse(access, { data });
  } catch (error) { return errorResponse(error); }
}
