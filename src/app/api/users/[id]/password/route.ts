// RBAC: user (admin, boss)
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// GET /api/users/[id]/password — Admin/boss view password hint
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles").select("role").eq("id", user.id).single();

    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: target, error } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("id", targetId)
      .single();

    if (error || !target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ hint: "Password was reset. User should check email or contact admin.", full_name: target.full_name });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

// PATCH /api/users/[id]/password — Reset password
// For [id]="change-password" — user changes own password
// For [id]=user-uuid — admin/boss resets target user's password
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const { password } = await request.json();

    if (!password || password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // F-07: this endpoint is an admin/boss RESET path only. Self-service change
    // must prove ownership of the current password, which /api/auth/change-password
    // does via signInWithPassword before updating. Without that proof, anyone
    // holding a live session could permanently take over the account.
    if (targetId === "change-password") {
      return NextResponse.json(
        { error: "Use POST /api/auth/change-password with oldPassword and newPassword" },
        { status: 400 }
      );
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles").select("role").eq("id", user.id).single();

    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(targetId, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // A3 · the order of the next two writes is load-bearing.
    //
    // password_changed_at is what 20260813000000's restrictive policy compares an
    // access token's `iat` against, so it goes first: from that moment the
    // target's already-minted access tokens are refused at the database, and the
    // revocation below is what stops a pre-reset REFRESH token from minting a new
    // one. force_password_change matches the two account-creation paths — the
    // administrator chose this password, so the target must replace it, and the A2
    // boundary (src/proxy.ts, src/lib/request-auth-context.ts) is what enforces
    // that server-side rather than trusting the client to redirect.
    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({ password_changed_at: new Date().toISOString(), force_password_change: true })
      .eq("id", targetId);

    if (profileErr) {
      return NextResponse.json(
        { error: "Password changed but audit timestamp could not be recorded. Please contact admin." },
        { status: 500 }
      );
    }

    // Fail closed. GoTrue v2.195.0 does revoke the target's sessions on an admin
    // password update — measured, see scripts/gotrue-revocation-drill.sh — but
    // that is a side effect of a 200 rather than a contract this repository owns,
    // and `auth` is not an exposed schema, so nothing here can observe it. This
    // RPC deletes whatever is left and verifies that nothing remains; if it cannot
    // say so, this request is not a completed reset and must not report one.
    const { data: revocation, error: revokeError } = await supabaseAdmin.rpc("revoke_user_sessions", {
      p_user_id: targetId,
      p_reason: "admin_password_reset",
    });

    if (revokeError || (revocation as { verified?: boolean } | null)?.verified !== true) {
      return NextResponse.json(
        {
          error:
            "Password changed, but the target's existing sessions could not be verifiably revoked. Treat the account as still signed in: retry, or ban the identity in Supabase Auth before relying on this reset.",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
