// RBAC: admin, boss, operator. GET /api/dispatch/reps
// The salespeople a lead can be handed to from the dispatch workbench: the same list the lead page uses (roles sales,
// operator, boss; active; no QA accounts). Read only; the browser no longer queries profiles itself.
import { NextRequest } from "next/server";
import { handle, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { filterLeadTransferCandidateQuery } from "@/lib/lead-transfer-candidates.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handle(request, "dispatch_reps", async ({ context, respond }) => {
    requireStaff(context);
    const query = supabaseAdmin.from("profiles").select("id,full_name,email,role,is_active");
    const { data, error } = await (filterLeadTransferCandidateQuery(query as never, { hideSystemAccounts: true }) as typeof query);
    if (error) throw error;
    return respond({ data: (data ?? []).map((p) => ({ id: p.id, full_name: p.full_name, email: p.email, role: p.role, is_active: p.is_active })) });
  });
}
