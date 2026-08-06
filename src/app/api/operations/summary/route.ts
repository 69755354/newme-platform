import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { errorResponse, jsonResponse } from "@/lib/shared-operations";

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.operations.read");
    const [workItems, approvals] = await Promise.all([
      access.context.supabase.from("shared_work_items").select("id", { count: "exact", head: true })
        .eq("organization_id", access.organizationId).not("status", "in", "(completed,cancelled)"),
      access.context.supabase.from("shared_approval_requests").select("id", { count: "exact", head: true })
        .eq("organization_id", access.organizationId).eq("status", "pending"),
    ]);
    if (workItems.error) throw workItems.error;
    if (approvals.error) throw approvals.error;
    const { count: deadLetters, error: deadLettersError } = await access.context.supabase
      .from("shared_outbox").select("id", { count: "exact", head: true })
      .eq("organization_id", access.organizationId).eq("state", "dead_letter");
    if (deadLettersError) throw deadLettersError;
    return jsonResponse(access, {
      data: {
        organization_id: access.organizationId,
        open_work_items: workItems.count ?? 0,
        pending_approvals: approvals.count ?? 0,
        dead_letters: deadLetters ?? 0,
      },
    });
  } catch (error) { return errorResponse(error); }
}
