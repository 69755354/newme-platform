import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { errorResponse, jsonResponse } from "@/lib/shared-operations";

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.operations.read");
    const { data, error } = await access.context.supabase.from("v4_shared_operations_summary")
      .select("*").eq("organization_id", access.organizationId).maybeSingle();
    if (error) throw error;
    return jsonResponse(access, { data });
  } catch (error) { return errorResponse(error); }
}
