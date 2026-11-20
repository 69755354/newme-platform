// RBAC: admin, boss, operator. POST /api/dispatch/{leadId}/decide {"action": "...", "reason": "..."}
// Actions: confirm_phone, release_missing, revoke_release, mark_test, unmark_test, note, reevaluate.
// The database routine dispatch_decide re-checks the actor and the reason rules; the same decision twice changes
// nothing. The signed-in user is always the actor: an actor in the body is ignored. No Meta feedback, no notification.
import { NextRequest } from "next/server";
import { ApiFailure, handle, invalid, readJson, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { isUuid, parseDecideInput } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, route: { params: Promise<{ leadId: string }> }) {
  return handle(request, "dispatch_decide", async ({ context, respond }) => {
    requireStaff(context);
    const { leadId } = await route.params;
    if (!isUuid(leadId)) throw new ApiFailure(404, "not_found");
    const parsed = parseDecideInput(await readJson(request));
    if (!parsed.ok) invalid(parsed.errors);
    const { action, reason } = parsed.value;
    const { data, error } = await supabaseAdmin.rpc("dispatch_decide", {
      p_lead_id: leadId, p_actor: context.user.id, p_action: action, p_reason: reason,
    });
    if (error) throw error;
    const result = (data ?? {}) as { status?: string; changed?: boolean };
    return respond({ ok: true, status: result.status ?? null, changed: Boolean(result.changed) });
  });
}
