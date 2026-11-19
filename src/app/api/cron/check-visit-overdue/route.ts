// RBAC: cron (x-cron-secret). PREPARED, NOT ENABLED: answers "Disabled" unless VISIT_OVERDUE_ALERTS_ENABLED=true
// is set in the runtime environment (S23).
//
// Overdue visit reports. Calls flag_overdue_visit_reports(), which writes one warning notification per recipient
// per overdue visit (event key visit-overdue:<visit id>), so running this route any number of times in a row
// changes nothing the second time. It sends no message outside the application and touches no Meta data.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";

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
  if (process.env.VISIT_OVERDUE_ALERTS_ENABLED !== "true") {
    return NextResponse.json({ message: "Disabled", reason: "Visit overdue alerts not enabled" }, { status: 200 });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc("flag_overdue_visit_reports", { p_now: new Date().toISOString() });
    if (error) throw error;
    const result = (data ?? {}) as { visits?: number; notified?: number };
    return NextResponse.json({ ok: true, visits: result.visits ?? 0, notified: result.notified ?? 0 });
  } catch (error) {
    logger.error({ operation: "visit_overdue_alerts", code: String((error as { code?: string })?.code ?? "unknown") }, "visit overdue scan failed");
    return NextResponse.json({ error: "Visit overdue scan failed" }, { status: 500 });
  }
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
