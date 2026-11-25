// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { notificationTypesForRole } from "@/lib/notification-display.mjs";

// GET /api/notifications/unread-count
export async function GET(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // S41: same role filter as GET /api/notifications so the badge equals the list.
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    const visibleTypes = notificationTypesForRole(profile?.role);
    let query = supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false);
    if (visibleTypes) query = query.in("type", visibleTypes);
    const { count, error } = await query;

    if (error) {
      console.error("[Notifications] unread-count error:", error);
      return NextResponse.json({ error: "Failed to get unread count" }, { status: 500 });
    }

    return NextResponse.json({ count: count || 0 });
  } catch (err: any) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
