import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { errorResponse, isUuid, jsonResponse, parseObject } from "@/lib/shared-operations";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.notifications.manage", "write");
    const { id } = await params;
    const body = parseObject(await request.json().catch(() => null));
    const queueKind = body?.queue_kind;
    if (!isUuid(id) || (queueKind !== "outbox" && queueKind !== "job")) {
      return errorResponse(new Error("shared_dead_letter_invalid"));
    }
    const { data, error } = await supabaseAdmin.rpc("v4_requeue_shared_dead_letter", {
      p_organization_id: access.organizationId, p_queue_kind: queueKind,
      p_record_id: id, p_actor_user_id: access.context.user.id,
      p_request_id: access.context.requestId,
    });
    if (error) throw error;
    return jsonResponse(access, { data });
  } catch (error) { return errorResponse(error); }
}
