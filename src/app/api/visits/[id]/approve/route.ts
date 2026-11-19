// RBAC: admin, boss, operator. POST {"decision":"approved"|"rejected","note":"..."} approves or rejects the plan.
// The database routine re-checks the actor; the same decision twice changes nothing.
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canReviewVisits, isUuid } from "@/lib/opportunity-visit.mjs";
import { ApiFailure, handle, readJson, withStatus } from "@/lib/opportunity-visit-api";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "visit_plan_approval", async ({ context, respond }) => {
    if (!canReviewVisits(context.role)) throw new ApiFailure(403, "forbidden");
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const body = await readJson(request);
    if (body.decision !== "approved" && body.decision !== "rejected") throw new ApiFailure(422, "invalid_plan_decision");
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : null;
    const { data: result, error } = await supabaseAdmin.rpc("visit_report_set_plan_approval", {
      p_visit_id: id, p_actor: context.user.id, p_decision: body.decision, p_note: note,
    });
    if (error) throw error;
    const { data, error: readError } = await supabaseAdmin.from("visit_reports").select("*").eq("id", id).single();
    if (readError) throw readError;
    return respond({ data: withStatus(data as Record<string, unknown>), changed: Boolean((result as { changed?: boolean } | null)?.changed) });
  });
}
