// RBAC: admin, boss, operator. GET /api/duplicates/{id}: one review with the lead in question and every matching
// candidate side by side (contact facts only, never the free-text notes).
import { NextRequest } from "next/server";
import { ApiFailure, handle, loadLeads, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { isUuid } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "duplicate_detail", async ({ context, respond }) => {
    requireStaff(context);
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const { data, error } = await supabaseAdmin.from("duplicate_reviews")
      .select("id, lead_id, duplicate_of_lead_id, candidate_ids, matched_on, decision, notes, decided_by, decided_at, created_at")
      .eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiFailure(404, "unknown_review");
    const review = data as Record<string, unknown> & { lead_id: string; duplicate_of_lead_id: string; candidate_ids: string[] | null };
    const candidateIds = (review.candidate_ids ?? []).slice(0, 10);
    const leads = await loadLeads([review.lead_id, review.duplicate_of_lead_id, ...candidateIds]);
    return respond({
      data: {
        ...review,
        lead: leads.get(review.lead_id) ?? null,
        original: leads.get(review.duplicate_of_lead_id) ?? null,
        candidates: candidateIds.map((candidate) => leads.get(candidate)).filter(Boolean),
      },
    });
  });
}
