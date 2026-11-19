// RBAC: admin, boss, operator. POST /api/duplicates/{id}/resolve {"decision":"merged"|"kept_separate"|"invalid","notes":"..."}
// merged = the same customer (linked to the original, nothing copied or deleted); kept_separate = two customers;
// invalid = not a real lead. Notes of at least 5 characters are required for kept_separate and invalid.
// The routine re-checks the actor; the same decision twice changes nothing; a decided review must be reopened first.
import { NextRequest } from "next/server";
import { ApiFailure, handle, invalid, readJson, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { isUuid, parseResolveInput } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "duplicate_resolve", async ({ context, respond }) => {
    requireStaff(context);
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const parsed = parseResolveInput(await readJson(request));
    if (!parsed.ok) invalid(parsed.errors);
    const { data, error } = await supabaseAdmin.rpc("resolve_duplicate_review", {
      p_review_id: id, p_actor: context.user.id, p_decision: parsed.value.decision, p_notes: parsed.value.notes,
    });
    if (error) throw error;
    const result = (data ?? {}) as { changed?: boolean; status?: string };
    return respond({ ok: true, changed: Boolean(result.changed), status: result.status ?? null });
  });
}
