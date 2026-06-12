import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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

function getSupabaseAuth(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
  });
  const accessToken = req.cookies.get("sb-access-token")?.value;
  const refreshToken = req.cookies.get("sb-refresh-token")?.value;
  if (accessToken && refreshToken) {
    client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  }
  return client;
}

export async function GET(request: NextRequest) {
  try {
    // Auth check
    const supabaseAuth = getSupabaseAuth(request);
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
