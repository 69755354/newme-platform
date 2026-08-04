import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { boundedLimit, errorResponse, jsonResponse } from "@/lib/shared-operations";

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.operations.read");
    const { data, error } = await access.context.supabase.from("shared_timeline_events").select("*")
      .eq("organization_id", access.organizationId).order("created_at", { ascending: false })
      .limit(boundedLimit(request, 200));
    if (error) throw error;
    return jsonResponse(access, { data: data ?? [] });
  } catch (error) { return errorResponse(error); }
}
