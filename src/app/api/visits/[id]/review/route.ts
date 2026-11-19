// RBAC: admin, boss, operator. POST {"decision":"accepted"|"needs_fix","notes":"...","action_done":true|false}.
// A fix request needs a note. The database routine re-checks the actor and the same decision twice changes nothing.
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canReviewVisits, isUuid } from "@/lib/opportunity-visit.mjs";
import { ApiFailure, handle, readJson, withStatus } from "@/lib/opportunity-visit-api";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "visit_review", async ({ context, respond }) => {
    if (!canReviewVisits(context.role)) throw new ApiFailure(403, "forbidden");
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const body = await readJson(request);
    if (body.decision !== "accepted" && body.decision !== "needs_fix") throw new ApiFailure(422, "invalid_review_decision");
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null;
    if (body.decision === "needs_fix" && !notes) throw new ApiFailure(422, "review_note_required");
    const actionDone = typeof body.action_done === "boolean" ? body.action_done : null;
    const { data: result, error } = await supabaseAdmin.rpc("visit_report_review", {
      p_visit_id: id, p_actor: context.user.id, p_decision: body.decision, p_notes: notes, p_action_done: actionDone,
    });
    if (error) throw error;
    const { data, error: readError } = await supabaseAdmin.from("visit_reports").select("*").eq("id", id).single();
    if (readError) throw readError;
    return respond({ data: withStatus(data as Record<string, unknown>), changed: Boolean((result as { changed?: boolean } | null)?.changed) });
  });
}
