// RBAC: admin, boss, operator (every lead) and sales (their own leads). Reads run with the caller's session,
// so row-level security decides what is visible; writes use the service role after the role and lead check.
// GET  /api/opportunities?lead_id=&stage=&include_archived=1&limit=&offset=   list (plus the stage list)
// POST /api/opportunities   create. Retrying the same request returns the same row (duplicate: true).
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseOpportunityInput, isUuid } from "@/lib/opportunity-visit.mjs";
import { ApiFailure, handle, invalid, loadStages, pageParams, readJson, requireLeadAccess } from "@/lib/opportunity-visit-api";

export const dynamic = "force-dynamic";

const SAME_KEYS = ["confirmed_requirement", "stage", "quote_amount_aed", "decision_target", "quotation_link"] as const;

export async function GET(request: NextRequest) {
  return handle(request, "opportunities_list", async ({ context, respond, db }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const url = new URL(request.url);
    const { limit, offset } = pageParams(url);
    const leadId = url.searchParams.get("lead_id");
    const stage = url.searchParams.get("stage");
    if (leadId && !isUuid(leadId)) throw new ApiFailure(400, "invalid_request");
    let query = db.from("opportunities")
      .select("*, leads(id, customer_name, assigned_to)", { count: "exact" })
      .order("created_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
    if (leadId) query = query.eq("lead_id", leadId);
    if (stage) query = query.eq("stage", stage);
    if (url.searchParams.get("include_archived") !== "1") query = query.eq("archived", false);
    const [{ data, error, count }, stages] = await Promise.all([query, loadStages(db)]);
    if (error) throw error;
    return respond({ data: data ?? [], stages, pagination: { limit, offset, total: count ?? 0, has_more: offset + limit < (count ?? 0) } });
  });
}

export async function POST(request: NextRequest) {
  return handle(request, "opportunities_create", async ({ context, respond, db }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const body = await readJson(request);
    const stages = await loadStages(db);
    const parsed = parseOpportunityInput(body, { stages });
    if (!parsed.ok) invalid(parsed.errors);
    const value = parsed.value as Record<string, unknown> & { lead_id: string; name: string };
    const lead = await requireLeadAccess(context, value.lead_id);
    // Sales always own what they create; staff may name another owner, otherwise the lead's owner.
    const owner = context.role === "sales" ? context.user.id : (value.owner_id as string | undefined) ?? lead.assigned_to ?? context.user.id;
    const { data, error } = await supabaseAdmin.from("opportunities")
      .insert({ ...value, owner_id: owner, created_by: context.user.id }).select("*").single();
    if (!error) return respond({ data, duplicate: false }, { status: 201 });
    if ((error as { code?: string }).code !== "23505") throw error;
    // The same name already exists on this lead: a retry of the same request returns it, a different one is a conflict.
    const { data: existing, error: lookupError } = await supabaseAdmin.from("opportunities").select("*")
      .eq("lead_id", value.lead_id).eq("archived", false).ilike("name", value.name.replace(/[\\%_]/g, "\\$&")).limit(1).maybeSingle();
    if (lookupError) throw lookupError;
    const same = existing && SAME_KEYS.every((key) => !(key in value) || (existing as Record<string, unknown>)[key] === value[key]
      || (key === "quote_amount_aed" && Number((existing as Record<string, unknown>)[key]) === value[key]));
    if (same) return respond({ data: existing, duplicate: true });
    throw new ApiFailure(409, "duplicate");
  });
}
