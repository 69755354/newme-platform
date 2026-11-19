// RBAC: admin, boss, operator. GET /api/duplicates?decision=pending|merged|kept_separate|invalid|withdrawn|all&limit=&offset=
// Duplicate reviews, each with the lead in question and the original side by side (contact facts only).
import { NextRequest } from "next/server";
import { ApiFailure, handle, loadLeads, pageParams, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";

export const dynamic = "force-dynamic";
const DECISIONS = new Set(["pending", "merged", "kept_separate", "invalid", "withdrawn", "all"]);

export async function GET(request: NextRequest) {
  return handle(request, "duplicates_list", async ({ context, respond }) => {
    requireStaff(context);
    const url = new URL(request.url);
    const decision = url.searchParams.get("decision") ?? "pending";
    if (!DECISIONS.has(decision)) throw new ApiFailure(400, "invalid_request");
    const { limit, offset } = pageParams(url);
    let query = supabaseAdmin.from("duplicate_reviews")
      .select("id, lead_id, duplicate_of_lead_id, candidate_ids, matched_on, decision, notes, decided_by, decided_at, created_at", { count: "exact" });
    if (decision !== "all") query = query.eq("decision", decision);
    const { data, error, count } = await query.order("created_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<Record<string, unknown> & { lead_id: string; duplicate_of_lead_id: string }>;
    const leads = await loadLeads(rows.flatMap((row) => [row.lead_id, row.duplicate_of_lead_id]));
    return respond({
      data: rows.map((row) => ({ ...row, lead: leads.get(row.lead_id) ?? null, original: leads.get(row.duplicate_of_lead_id) ?? null })),
      pagination: { limit, offset, total: count ?? rows.length, has_more: offset + limit < (count ?? rows.length) },
    });
  });
}
