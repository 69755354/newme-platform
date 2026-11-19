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

/** Mirrors visitReportStatus() / public.visit_report_status() as database predicates, so the filter runs before range and count. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyStatusFilter(query: any, status: string, nowIso: string) {
  switch (status) {
    case "reviewed": return query.not("submitted_at", "is", null).eq("review_status", "accepted");
    case "completed": return query.not("submitted_at", "is", null).neq("review_status", "accepted");
    case "overdue": return query.is("submitted_at", null).neq("plan_approval", "rejected").lt("report_due_at", nowIso);
    case "approved": return query.is("submitted_at", null).eq("plan_approval", "approved").gte("report_due_at", nowIso);
    default: // planned: open, not approved, not overdue (a rejected plan never becomes overdue)
      return query.is("submitted_at", null).in("plan_approval", ["pending", "rejected"]).or(`plan_approval.eq.rejected,report_due_at.gte.${nowIso}`);
  }
}

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
    if (status) query = applyStatusFilter(query, status, new Date().toISOString());
    const { data, error, count } = await query;
    if (error) throw error;
    const rows = (data ?? []).map((row) => withStatus(row as Record<string, unknown>));
    // The status filter already ran in the database (before the page range and the count); this keeps the answer
    // consistent with the derived status if the clock moved between the two.
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
    // A retry is the same request only if every persisted input field matches (an absent field means null).
    const row = (existing ?? {}) as Record<string, unknown>;
    const instant = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).getTime());
    const plain = (v: unknown) => (v === undefined ? null : v);
    const same = !!existing
      && ["planned_at", "actual_start", "actual_finish"].every((key) => instant(row[key]) === instant(value[key]))
      && ["purpose", "location", "person_to_meet", "opportunity_id", "result", "next_action", "next_followup_date", "evidence_link"]
        .every((key) => plain(row[key]) === plain(value[key]))
      && row.owner_id === owner;
    if (same) return respond({ data: withStatus(existing as Record<string, unknown>), duplicate: true });
    throw new ApiFailure(409, "duplicate");
  });
}
