// RBAC: admin, boss, operator, or the sales owner of the visit's lead. POST hands in the report: the plan must be
// approved and the actual times and the result filled in. Submitting twice changes nothing.
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isUuid } from "@/lib/opportunity-visit.mjs";
import { ApiFailure, handle, requireLeadAccess, withStatus } from "@/lib/opportunity-visit-api";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  return handle(request, "visit_submit", async ({ context, respond }) => {
    if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
    const { id } = await route.params;
    if (!isUuid(id)) throw new ApiFailure(404, "not_found");
    const { data: existing, error: readError } = await supabaseAdmin.from("visit_reports").select("id, lead_id").eq("id", id).maybeSingle();
    if (readError) throw readError;
    if (!existing) throw new ApiFailure(404, "not_found");
    await requireLeadAccess(context, existing.lead_id as string);
    const { data: result, error } = await supabaseAdmin.rpc("visit_report_submit", { p_visit_id: id, p_actor: context.user.id });
    if (error) throw error;
    const { data, error: rereadError } = await supabaseAdmin.from("visit_reports").select("*").eq("id", id).single();
    if (rereadError) throw rereadError;
    return respond({ data: withStatus(data as Record<string, unknown>), changed: Boolean((result as { changed?: boolean } | null)?.changed) });
  });
}
