// RBAC: admin, boss, operator. POST /api/duplicates/{id}/reopen {"reason":"..."} puts a decided review back to pending.
// The earlier decision stays in the history. The routine re-checks the actor.
import { NextRequest } from "next/server";
import { ApiFailure, handle, invalid, readJson, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { isUuid, parseReopenInput } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "duplicate_reopen", async ({ context, respond }) => {
    requireStaff(context);
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const parsed = parseReopenInput(await readJson(request));
    if (!parsed.ok) invalid(parsed.errors);
    const { data, error } = await supabaseAdmin.rpc("reopen_duplicate_review", {
      p_review_id: id, p_actor: context.user.id, p_reason: parsed.value.reason,
    });
    if (error) throw error;
    const result = (data ?? {}) as { changed?: boolean; status?: string };
    return respond({ ok: true, changed: Boolean(result.changed), status: result.status ?? null });
  });
}
