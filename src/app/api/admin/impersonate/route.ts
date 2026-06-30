import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// POST /api/admin/impersonate
// Admin generates a magic link to sign in as another user
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify caller is admin or boss
  const { data: callerProfile } = await supabaseAdmin
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  if (!callerProfile || !["admin", "boss"].includes(callerProfile.role)) {
    return NextResponse.json({ error: "Forbidden: admin/boss only" }, { status: 403 });
  }

  const { targetUserId } = await request.json();
  if (!targetUserId) {
    return NextResponse.json({ error: "targetUserId required" }, { status: 400 });
  }

  // Verify target user exists
  const { data: targetProfile } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("id", targetUserId)
    .single();

  if (!targetProfile) {
    return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  }

  // Generate magic link for target user
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: targetProfile.email,
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || "https://app.newme.ae"}/auth/callback`,
    },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Log to audit_logs (graceful degradation if table not yet created)
  supabaseAdmin.from("audit_logs").insert({
    actor_id: user.id,
    actor_email: user.email,
    action: "impersonate",
    target_type: "user",
    target_id: targetUserId,
    details: {
      actor_name: callerProfile.full_name,
      actor_role: callerProfile.role,
      target_name: targetProfile.full_name,
      target_role: targetProfile.role,
    },
  }).then(({ error }) => {
    if (error) console.warn("[audit] Failed to log impersonation:", error.message);
  });

  return NextResponse.json({
    url: data.properties?.action_link,
    targetUser: {
      id: targetProfile.id,
      email: targetProfile.email,
      full_name: targetProfile.full_name,
      role: targetProfile.role,
    },
  });
}
