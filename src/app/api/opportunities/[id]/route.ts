// RBAC: admin, boss, operator, or the sales owner of the opportunity's lead.
// GET   /api/opportunities/{id}   one opportunity
// PATCH /api/opportunities/{id}   change fields, stage or archive it (stage rules are checked here and in the database)
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isUuid, parseOpportunityInput } from "@/lib/opportunity-visit.mjs";
import { ApiFailure, handle, invalid, loadStages, readJson, requireLeadAccess } from "@/lib/opportunity-visit-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "opportunity_read", async ({ context, respond, db }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const { data, error } = await db.from("opportunities").select("*, leads(id, customer_name, assigned_to)").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiFailure(404, "not_found");
    return respond({ data, stages: await loadStages(db) });
  });
}

export async function PATCH(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "opportunity_update", async ({ context, respond, db }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const { data: existing, error: readError } = await supabaseAdmin.from("opportunities").select("*").eq("id", id).maybeSingle();
    if (readError) throw readError;
    if (!existing) throw new ApiFailure(404, "not_found");
    await requireLeadAccess(context, existing.lead_id as string);
    const body = await readJson(request);
    // The lead of an opportunity never changes, and only staff may move it to another owner.
    delete body.lead_id;
    if (context.role === "sales") delete body.owner_id;
    const parsed = parseOpportunityInput(body, { stages: await loadStages(db), partial: true, existing });
    if (!parsed.ok) invalid(parsed.errors);
    const { data, error } = await supabaseAdmin.from("opportunities").update(parsed.value).eq("id", id).select("*").single();
    if (error) throw error;
    return respond({ data });
  });
}
