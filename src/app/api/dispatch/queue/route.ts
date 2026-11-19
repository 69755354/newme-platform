// RBAC: admin, boss, operator. GET /api/dispatch/queue?status=&limit=&offset=
// Counts for the seven dispatch states plus the rows of one state (default: the first state that needs a person).
// Read only. Each row carries the lead's contact facts the administrator needs (never the free-text notes) and, for
// a lead in duplicate review, the pending review with the original lead side by side.
import { NextRequest } from "next/server";
import { ApiFailure, handle, loadLeads, pageParams, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { ATTENTION_STATUSES, DISPATCH_STATUSES, allowedActions } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";
const STATE_COLUMNS = "lead_id, status, missing_fields, phone_norm, phone_flag, routing_note, admin_note, release_reason, evaluated_at, updated_at";
// Archived leads (leads.archived, set by /api/leads/archive) leave the queue and the counts: inner join + filter.
const LIVE_JOIN = "leads!inner(archived)";

export async function GET(request: NextRequest) {
  return handle(request, "dispatch_queue", async ({ context, respond }) => {
    requireStaff(context);
    const url = new URL(request.url);
    const requested = url.searchParams.get("status");
    if (requested && !(DISPATCH_STATUSES as readonly string[]).includes(requested)) throw new ApiFailure(400, "invalid_request");
    const status = requested ?? ATTENTION_STATUSES[0];
    const { limit, offset } = pageParams(url);

    const countResults = await Promise.all(DISPATCH_STATUSES.map(async (name) => {
      const { count, error } = await supabaseAdmin.from("lead_dispatch_state").select(`lead_id, ${LIVE_JOIN}`, { count: "exact", head: true }).eq("status", name).eq("leads.archived", false);
      if (error) throw error;
      return [name, count ?? 0] as const;
    }));
    const counts = Object.fromEntries(countResults);

    const { data: states, error } = await supabaseAdmin.from("lead_dispatch_state").select(`${STATE_COLUMNS}, ${LIVE_JOIN}`)
      .eq("status", status).eq("leads.archived", false).order("updated_at", { ascending: false }).order("lead_id").range(offset, offset + limit - 1);
    if (error) throw error;
    // the join exists only for the filter; keep the response shape unchanged
    const rows = ((states ?? []) as Array<Record<string, unknown> & { lead_id: string }>).map((row) => { const rest = { ...row }; delete rest.leads; return rest; });
    const leadIds = rows.map((row) => row.lead_id);

    const reviews = new Map<string, Record<string, unknown>>();
    if ((status === "duplicate_review" || status === "duplicate_not_dispatched") && leadIds.length) {
      // the open review for a lead in review; the decision that closed it for a lead that is not dispatched
      const wanted = status === "duplicate_review" ? ["pending"] : ["merged", "invalid"];
      const { data: found, error: reviewError } = await supabaseAdmin.from("duplicate_reviews")
        .select("id, lead_id, duplicate_of_lead_id, matched_on, candidate_ids, decision, notes, created_at").in("lead_id", leadIds).in("decision", wanted);
      if (reviewError) throw reviewError;
      for (const review of (found ?? []) as Array<Record<string, unknown> & { lead_id: string }>) reviews.set(review.lead_id, review);
    }
    const originalIds = [...reviews.values()].map((review) => review.duplicate_of_lead_id as string);
    const leads = await loadLeads([...leadIds, ...originalIds]);

    const data = rows.map((row) => {
      const review = reviews.get(row.lead_id);
      return {
        ...row,
        lead: leads.get(row.lead_id) ?? null,
        allowed_actions: allowedActions(row as never),
        duplicate: review ? {
          review_id: review.id, decision: review.decision, notes: review.notes ?? null, matched_on: review.matched_on, candidates: (review.candidate_ids as string[] | undefined)?.length ?? 1,
          original: leads.get(review.duplicate_of_lead_id as string) ?? null,
        } : null,
      };
    });
    return respond({
      status, counts, data,
      pagination: { limit, offset, total: counts[status] ?? 0, has_more: offset + limit < (counts[status] ?? 0) },
    });
  });
}
