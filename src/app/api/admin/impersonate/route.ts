// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// POST /api/admin/impersonate
// Admin generates a magic link to sign in as another user.
// This legacy internal-admin endpoint is not a platform-support role model.
export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify caller is admin or boss.
  const { data: callerProfile } = await supabaseAdmin
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  if (!callerProfile || !["admin", "boss"].includes(callerProfile.role)) {
    return NextResponse.json({ error: "Forbidden: admin/boss only" }, { status: 403 });
  }

  const payload: unknown = await request.json().catch(() => null);
  const input = payload && typeof payload === "object"
    ? payload as { targetUserId?: unknown; reason?: unknown }
    : {};
  const targetUserId = typeof input.targetUserId === "string" ? input.targetUserId.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";

  if (!targetUserId) {
    return NextResponse.json({ error: "targetUserId required" }, { status: 400 });
  }

  if (!reason) {
    return NextResponse.json({ error: "reason required" }, { status: 400 });
  }

  // Verify target user exists.
  const { data: targetProfile } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("id", targetUserId)
    .single();

  if (!targetProfile) {
    return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  }

  // Fail closed: a high-risk magic link is not generated unless its requested
  // access and reason have first been durably recorded.
  const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({
    actor_id: user.id,
    actor_email: user.email,
    action: "impersonate_link_requested",
    target_type: "user",
    target_id: targetUserId,
    details: {
      actor_name: callerProfile.full_name,
      actor_role: callerProfile.role,
      target_name: targetProfile.full_name,
      target_role: targetProfile.role,
      reason,
    },
  });

  if (auditError) {
    return NextResponse.json(
      { error: "Audit logging unavailable; access denied" },
      { status: 503 },
    );
  }

  // Generate the magic link only after the audit write succeeds.
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
