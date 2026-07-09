// RBAC: cron (x-cron-secret, disabled)
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/cron/check-overdue-followups
 * 🔴 DISABLED 2026-06-27 — redundant with check-alerts, no effective dedup.
 * Original code in git history. Re-enable after dedup fix.
 */
export async function GET(_request: NextRequest) {
  return NextResponse.json({ message: "Disabled", reason: "redundant — re-enable after dedup fix" }, { status: 200 });
}
