// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/knx-task-store";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";

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

    return NextResponse.json(task);
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
