import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

// GET /api/notifications/unread-count
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { createClient } = await import("@supabase/supabase-js");
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { count, error } = await adminClient
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false);

    if (error) {
      console.error("[Notifications] unread-count error:", error);
      return NextResponse.json({ error: "Failed to get unread count" }, { status: 500 });
    }

    // Heartbeat tracking: fire-and-forget, throttled to 5-min intervals
    const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
    const { data: profile } = await adminClient
      .from("profiles")
      .select("last_active_at")
      .eq("id", user.id)
      .single();

    const skipUpdate = profile?.last_active_at && profile.last_active_at >= fiveMinAgo;

    if (!skipUpdate) {
      const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || request.headers.get("x-real-ip")
        || "unknown";

      adminClient.from("profiles")
        .update({ last_active_at: new Date().toISOString() })
        .eq("id", user.id)
        .then(({ error }) => {
          if (error) console.error("[unread-count] profile update error:", error.message);
        });

      adminClient.from("audit_logs").insert({
        actor_id: user.id,
        action: "HEARTBEAT",
        details: { source: "unread-count-poll" },
        ip_address: clientIp,
      }).then(({ error }) => {
        if (error) console.error("[unread-count] audit_log insert error:", error.message);
      });
    }

    return NextResponse.json({ count: count || 0 });
  } catch (err: any) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
