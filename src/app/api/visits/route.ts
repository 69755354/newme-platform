// RBAC: admin, boss, operator (every lead) and sales (their own leads). Reads run with the caller's session,
// so row-level security decides what is visible; writes use the service role after the role and lead check.
// GET  /api/visits?lead_id=&status=&include_archived=1&limit=&offset=   list, each row with its derived status
// POST /api/visits   plan a visit. Retrying the same request returns the same row (duplicate: true).
// Plan approval, submission and review have their own routes; this one never sets them.
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isUuid, parseVisitInput } from "@/lib/opportunity-visit.mjs";
import { ApiFailure, handle, invalid, pageParams, readJson, requireLeadAccess, withStatus } from "@/lib/opportunity-visit-api";

export const dynamic = "force-dynamic";
const STATUSES = new Set(["planned", "approved", "completed", "reviewed", "overdue"]);

export async function GET(request: NextRequest) {
  return handle(request, "visits_list", async ({ context, respond, db }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const url = new URL(request.url);
    const { limit, offset } = pageParams(url);
    const leadId = url.searchParams.get("lead_id");
    const status = url.searchParams.get("status");
    if (leadId && !isUuid(leadId)) throw new ApiFailure(400, "invalid_request");
    if (status && !STATUSES.has(status)) throw new ApiFailure(400, "invalid_request");
    let query = db.from("visit_reports")
      .select("*, leads(id, customer_name, assigned_to)", { count: "exact" })
      .order("planned_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
    if (leadId) query = query.eq("lead_id", leadId);
    if (url.searchParams.get("include_archived") !== "1") query = query.eq("archived", false);
    const { data, error, count } = await query;
    if (error) throw error;
    const rows = (data ?? []).map((row) => withStatus(row as Record<string, unknown>));
    // The status is derived from the clock, so the filter runs on the page after the derivation.
    const filtered = status ? rows.filter((row) => row.status === status) : rows;
    const opportunityIds = [...new Set(filtered.map((row) => row.opportunity_id as string | null).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (opportunityIds.length) {
      const { data: opportunities, error: opportunityError } = await db.from("opportunities").select("id, name").in("id", opportunityIds);
      if (opportunityError) throw opportunityError;
      for (const o of opportunities ?? []) names.set(o.id as string, o.name as string);
    }
    return respond({
      data: filtered.map((row) => ({ ...row, opportunity_name: row.opportunity_id ? names.get(row.opportunity_id as string) ?? null : null })),
      pagination: { limit, offset, total: count ?? 0, has_more: offset + limit < (count ?? 0) },
    });
  });
}

export async function POST(request: NextRequest) {
  return handle(request, "visits_create", async ({ context, respond }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const parsed = parseVisitInput(await readJson(request));
    if (!parsed.ok) invalid(parsed.errors);
    const value = parsed.value as Record<string, unknown> & { lead_id: string; planned_at: string; purpose: string };
    const lead = await requireLeadAccess(context, value.lead_id);
    const owner = context.role === "sales" ? context.user.id : (value.owner_id as string | undefined) ?? lead.assigned_to ?? context.user.id;
    const { data, error } = await supabaseAdmin.from("visit_reports")
      .insert({ ...value, owner_id: owner, created_by: context.user.id }).select("*").single();
    if (!error) return respond({ data: withStatus(data as Record<string, unknown>), duplicate: false }, { status: 201 });
    if ((error as { code?: string }).code !== "23505") throw error;
    const { data: existing, error: lookupError } = await supabaseAdmin.from("visit_reports").select("*")
      .eq("lead_id", value.lead_id).eq("planned_at", value.planned_at).eq("archived", false).maybeSingle();
    if (lookupError) throw lookupError;
    const same = existing && ["purpose", "location", "person_to_meet", "opportunity_id"].every((key) => !(key in value)
      || (existing as Record<string, unknown>)[key] === value[key]);
    if (same) return respond({ data: withStatus(existing as Record<string, unknown>), duplicate: true });
    throw new ApiFailure(409, "duplicate");
  });
}
