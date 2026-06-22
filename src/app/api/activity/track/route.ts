import { NextRequest, NextResponse } from "next/server";

// POST /api/activity/track — record real page navigation
export async function POST(request: NextRequest) {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Extract user from auth cookie
    const { createServerClient } = await import("@supabase/ssr");
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => request.cookies.getAll().map(c => ({ name: c.name, value: c.value })),
          setAll: () => {},
        },
      }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const page = body.page || "/unknown";

    // 5-min throttle via DB
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

      // Fire-and-forget: profile + audit_log
      adminClient.from("profiles")
        .update({ last_active_at: new Date().toISOString() })
        .eq("id", user.id)
        .then(({ error }) => {
          if (error) console.error("[activity/track] profile update error:", error.message);
        });

      adminClient.from("audit_logs").insert({
        actor_id: user.id,
        action: "PAGE_VISIT",
        details: { page, source: "spa-navigation" },
        ip_address: clientIp,
      }).then(({ error }) => {
        if (error) console.error("[activity/track] audit_log insert error:", error.message);
      });
    }

    return NextResponse.json({ ok: true, tracked: !skipUpdate });
  } catch (err: any) {
    console.error("[activity/track] error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
