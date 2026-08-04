import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import {
  boundedLimit, errorResponse, isUuid, jsonResponse, parseObject, text,
} from "@/lib/shared-operations";

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.operations.read");
    const status = new URL(request.url).searchParams.get("status");
    let query = access.context.supabase.from("shared_work_items").select("*")
      .eq("organization_id", access.organizationId)
      .order("created_at", { ascending: false }).limit(boundedLimit(request));
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return jsonResponse(access, { data: data ?? [] });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.work.write", "write");
    const body = parseObject(await request.json().catch(() => null));
    const title = text(body?.title, 160);
    const idempotencyKey = text(body?.idempotency_key, 160);
    if (!body || !title || !idempotencyKey) return errorResponse(new Error("shared_work_item_invalid"));
    const assignee = body.assignee_user_id == null ? null : isUuid(body.assignee_user_id) ? body.assignee_user_id : undefined;
    const sourceId = body.source_id == null ? null : isUuid(body.source_id) ? body.source_id : undefined;
    if (assignee === undefined || sourceId === undefined) return errorResponse(new Error("shared_work_item_invalid"));
    const { data, error } = await access.context.supabase.rpc("v4_create_shared_work_item", {
      p_organization_id: access.organizationId,
      p_title: title,
      p_details: typeof body.details === "string" ? body.details.slice(0, 4000) : "",
      p_priority: text(body.priority, 16) ?? "normal",
      p_assignee_user_id: assignee,
      p_due_at: typeof body.due_at === "string" ? body.due_at : null,
      p_source_type: text(body.source_type, 64),
      p_source_id: sourceId,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    return jsonResponse(access, { data }, 201);
  } catch (error) { return errorResponse(error); }
}
