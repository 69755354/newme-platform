import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { getStore } from "@/lib/knx-task-store";

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

const tasks = new Map<string, any>();

// We need to share the in-memory task store with the POST route.
// This is a simple approach — in production use Redis/DB.
// We use a global variable to share state across route files.
const globalStore = (global as any).__hermesKnxTasks;
if (!(global as any).__hermesKnxTasks) {
  (global as any).__hermesKnxTasks = new Map<string, any>();
}

function getTaskStore(): Map<string, any> {
  return (global as any).__hermesKnxTasks;
}

// Auth client resolved from @supabase/ssr session cookie via createServerSupabase.
// (Replaces the old getSupabaseAuth helper that read sb-access-token cookies.)

export async function GET(request: NextRequest) {
  try {
    // Auth check
    const supabaseAuth = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Role check — only admin/boss/sales can check design status
    const { createClient: createAdmin } = await import("@supabase/supabase-js");
    const adminClient = createAdmin(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data: profile } = await adminClient
      .from("profiles").select("role").eq("id", user.id).single();
    if (!profile || !["admin", "boss", "sales"].includes(profile.role)) {
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
