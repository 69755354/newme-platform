// RBAC: cron (x-cron-secret). PREPARED, NOT ENABLED: answers "Disabled" unless DISPATCH_SWEEP_ENABLED=true is set in
// the runtime environment (S24).
//
// Dispatch sweep. Calls sweep_lead_dispatch(): evaluates leads created in the last seven days that have no dispatch
// state and re-evaluates the ones that changed since their last evaluation (at most 200 per run). It writes dispatch
// rows only; it never writes a lead, sends no message and touches no Meta data. Running it again changes nothing.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import { sweepWindowStart } from "@/lib/lead-dispatch.mjs";

export const dynamic = "force-dynamic";

function secretMatches(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request) {
  if (!secretMatches(request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.DISPATCH_SWEEP_ENABLED !== "true") {
    return NextResponse.json({ message: "Disabled", reason: "Dispatch sweep not enabled" }, { status: 200 });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc("sweep_lead_dispatch", { p_since: sweepWindowStart(), p_limit: 200 });
    if (error) throw error;
    const result = (data ?? {}) as { evaluated?: number; changed?: number };
    return NextResponse.json({ ok: true, evaluated: result.evaluated ?? 0, changed: result.changed ?? 0 });
  } catch (error) {
    logger.error({ operation: "dispatch_sweep", code: String((error as { code?: string })?.code ?? "unknown") }, "dispatch sweep failed");
    return NextResponse.json({ error: "Dispatch sweep failed" }, { status: 500 });
  }
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
