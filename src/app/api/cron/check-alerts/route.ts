// RBAC: cron (x-cron-secret, disabled)
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/cron/check-alerts
 * 🔴 DISABLED 2026-06-27 — generates 432+ spam per call.
 * Each overdue lead → 5+ duplicate notifs (1 sales + 4 admins).
 * Original code in git history. Re-enable after dedup fix.
 */
export async function GET(_request: NextRequest) {
  return NextResponse.json({ message: "Disabled", reason: "spam — re-enable after dedup fix" }, { status: 200 });
}
