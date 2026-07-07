import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/models/supabase-server";
import { VALID_NOTIFICATION_TYPES } from "@/services/notifications";
import type { NotificationType } from "@/services/notifications";

// GET /api/notifications?limit=20&offset=0&unread_only=false
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 100);
    const offset = parseInt(searchParams.get("offset") || "0");
    const unreadOnly = searchParams.get("unread_only") === "true";

    // Check role for admin/boss access
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const isAdmin = profile && ["admin", "boss"].includes(profile.role);

    let query = supabase
      .from("notifications")
      .select("*");

    if (isAdmin) {
      // Admin/boss sees all
    } else {
      // Regular user sees only their own
      query = query.eq("user_id", user.id);
    }

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)
      .limit(limit);

    if (error) {
      console.error("[Notifications] GET error:", error);
      return NextResponse.json({ error: "Failed to fetch notifications" }, { status: 500 });
    }

    return NextResponse.json({ data, count });
  } catch (err: any) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/notifications
 * Create a notification directly. Requires admin/boss role.
 * Used by admin dashboard or system automation.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify admin/boss role
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden: admin/boss only" }, { status: 403 });
    }

    const body = await request.json();
    const { user_id, type, title, body: notifBody, related_id, related_type } = body as {
      user_id?: string;
      type?: string;
      title?: string;
      body?: string;
      related_id?: string;
      related_type?: string;
    };

    if (!user_id || !type || !title) {
      return NextResponse.json({ error: "user_id, type, and title are required" }, { status: 400 });
    }

    if (!VALID_NOTIFICATION_TYPES.includes(type as NotificationType)) {
      return NextResponse.json({ error: `Invalid type: ${type}` }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("notifications")
      .insert({
        user_id,
        type,
        title,
        body: notifBody || null,
        related_id: related_id || null,
        related_type: related_type || null,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[Notifications] POST error:", error);
      return NextResponse.json({ error: "Failed to create notification" }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: data.id }, { status: 201 });
  } catch (err: any) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
