// RBAC: admin, boss, operator (any lead) and sales (their own lead, label only).
// GET /api/dispatch/{leadId}: the dispatch state of one lead, or data: null when it has not been evaluated yet.
import { NextRequest } from "next/server";
import { ApiFailure, handle, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { canDecide, isUuid } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, route: { params: Promise<{ leadId: string }> }) {
  return handle(request, "dispatch_lead", async ({ context, respond }) => {
    const staff = canDecide(context.role);
    if (!staff && context.role !== "sales") throw new ApiFailure(403, "forbidden");
    const { leadId } = await route.params;
    if (!isUuid(leadId)) throw new ApiFailure(404, "not_found");
    const { data: lead, error: leadError } = await supabaseAdmin.from("leads").select("id, assigned_to").eq("id", leadId).maybeSingle();
    if (leadError) throw leadError;
    if (!lead) throw new ApiFailure(404, "unknown_lead");
    if (!staff && (lead as { assigned_to: string | null }).assigned_to !== context.user.id) throw new ApiFailure(403, "forbidden");
    const { data: state, error } = await supabaseAdmin.from("lead_dispatch_state")
      .select("lead_id, status, missing_fields, phone_flag, routing_note, admin_note, release_reason, evaluated_at, updated_at")
      .eq("lead_id", leadId).maybeSingle();
    if (error) throw error;
    if (!state) return respond({ data: null });
    const row = state as Record<string, unknown>;
    // A salesperson sees the label and what is missing, nothing about reviews or other customers.
    if (!staff) return respond({ data: { status: row.status, missing_fields: row.missing_fields } });
    let duplicate = null;
    if (row.status === "duplicate_review") {
      const { data: review, error: reviewError } = await supabaseAdmin.from("duplicate_reviews")
        .select("id, duplicate_of_lead_id, matched_on").eq("lead_id", leadId).eq("decision", "pending").maybeSingle();
      if (reviewError) throw reviewError;
      if (review) duplicate = { review_id: (review as { id: string }).id, original_id: (review as { duplicate_of_lead_id: string }).duplicate_of_lead_id, matched_on: (review as { matched_on: string[] }).matched_on };
    }
    return respond({ data: { ...row, duplicate } });
  });
}
