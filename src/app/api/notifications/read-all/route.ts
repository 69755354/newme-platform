// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

// POST /api/notifications/read-all — mark all notifications as read
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", user.id)
      .eq("is_read", false)
      .select();

    if (error) {
      console.error("[Notifications] read-all error:", error);
      return NextResponse.json({ error: "Failed to mark all as read" }, { status: 500 });
    }

    return NextResponse.json({ success: true, count: data?.length || 0 });
  } catch (err: any) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
