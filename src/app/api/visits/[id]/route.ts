// RBAC: admin, boss, operator, or the sales owner of the visit's lead.
// GET   /api/visits/{id}   one visit with its derived status
// PATCH /api/visits/{id}   edit the plan or the report fields, or archive. Editing an approved plan sends it back for
//                          approval and a submitted report is locked (both enforced by the database).
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isUuid, parseVisitInput } from "@/lib/opportunity-visit.mjs";
import { ApiFailure, handle, invalid, readJson, requireLeadAccess, withStatus } from "@/lib/opportunity-visit-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "visit_read", async ({ context, respond, db }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const { data, error } = await db.from("visit_reports").select("*, leads(id, customer_name, assigned_to)").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiFailure(404, "not_found");
    return respond({ data: withStatus(data as Record<string, unknown>) });
  });
}

export async function PATCH(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "visit_update", async ({ context, respond }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const { data: existing, error: readError } = await supabaseAdmin.from("visit_reports").select("id, lead_id").eq("id", id).maybeSingle();
    if (readError) throw readError;
    if (!existing) throw new ApiFailure(404, "not_found");
    await requireLeadAccess(context, existing.lead_id as string);
    const body = await readJson(request);
    delete body.lead_id;
    if (context.role === "sales") delete body.owner_id;
    const parsed = parseVisitInput(body, { partial: true });
    if (!parsed.ok) invalid(parsed.errors);
    const { data, error } = await supabaseAdmin.from("visit_reports").update(parsed.value).eq("id", id).select("*").single();
    if (error) throw error;
    return respond({ data: withStatus(data as Record<string, unknown>) });
  });
}
