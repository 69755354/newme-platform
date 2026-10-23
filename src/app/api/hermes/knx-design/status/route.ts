// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/knx-task-store";
import { getAuthProfile, isAdminOrBoss, canAccessLead } from "@/lib/lead-auth";

/**
 * GET /api/hermes/knx-design/status?task_id=xxx
 *
 * Returns the current progress of a KNX design task.
 *
 * Response:
 *   { status: "started"|"running"|"completed"|"failed",
 *     progress_pct: number,
 *     progress_label: string,
 *     result?: { ... },   // only when completed
 *     error?: string      // only when failed
 *   }
 */

export async function GET(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const profile = await getAuthProfile(bearerToken, cookieHeader);
    if (!profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isAdminOrBoss(profile) && profile.role !== "sales") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const taskId = request.nextUrl.searchParams.get("task_id");
    if (!taskId) {
      return NextResponse.json({ error: "task_id required" }, { status: 400 });
    }

    const store = getStore();
    const task = store.get(taskId);

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Recheck current lead access on every poll, including after reassignment.
    if (!task.lead_id || !(await canAccessLead(task.lead_id, profile, bearerToken, cookieHeader))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({
      status: task.status,
      progress_pct: task.progress_pct,
      progress_label: task.progress_label,
      result: task.result,
      error: task.error,
    });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
