// RBAC: admin, boss, operator. POST /api/dispatch/refresh
// Evaluates the leads created or changed in the last seven days that have no state or a stale one, at most 100 per
// call (the database routine sweep_lead_dispatch). It is not a backfill: the first fill of all existing leads is a
// script run by the release gate. It changes only dispatch rows, never a lead.
import { NextRequest } from "next/server";
import { handle, requireStaff, supabaseAdmin } from "@/lib/lead-dispatch-api";
import { sweepWindowStart } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handle(request, "dispatch_refresh", async ({ context, respond }) => {
    requireStaff(context);
    const { data, error } = await supabaseAdmin.rpc("sweep_lead_dispatch", { p_since: sweepWindowStart(), p_limit: 100 });
    if (error) throw error;
    const result = (data ?? {}) as { evaluated?: number; changed?: number };
    return respond({ ok: true, evaluated: result.evaluated ?? 0, changed: result.changed ?? 0 });
  });
}
