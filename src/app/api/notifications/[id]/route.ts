// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

// PATCH /api/notifications/[id] — mark a single notification as read
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const isRead = body.is_read !== false; // default to true

    // Ensure user owns this notification (or is admin/boss)
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile?.role) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const isAdmin = ["admin", "boss"].includes(profile.role);

    let query = supabase
      .from("notifications")
      .update({ is_read: isRead })
      .eq("id", id);

    if (!isAdmin) {
      query = query.eq("user_id", user.id);
    }

    const { error } = await query;

    if (error) {
      console.error("[Notifications] PATCH error:", error);
      return NextResponse.json({ error: "Failed to update notification" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err instanceof Error
          ? err.message
          : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
