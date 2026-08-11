// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";

// POST /api/auth/change-password
export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { oldPassword, newPassword } = await request.json();

    if (!oldPassword || !newPassword) {
      return NextResponse.json({ error: "oldPassword and newPassword required" }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    // Verify the old password against the AUTH identity, never against
    // public.profiles.email.
    //
    // profiles.email was a self-writable column, so reading the address from
    // there made this route an account-takeover primitive: PATCH your own
    // profiles.email to a victim's address, then POST here with that victim's
    // password as `oldPassword`. signInWithPassword would succeed against the
    // victim's credentials while updateUserById below reset the password of
    // *this* session's user — a password oracle that also let an attacker
    // confirm a guessed credential for any account.
    //
    // user.email comes from supabase.auth.getUser(), i.e. from the JWT verified
    // upstream, and cannot be influenced by anything the caller can write.
    // 20260811100100_f06_profiles_revocation_columns.sql also removes the
    // profiles.email grant, so both halves of the chain are closed.
    if (!user.email) {
      return NextResponse.json({ error: "Account has no email identity" }, { status: 400 });
    }

    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: oldPassword,
    });

    if (signInErr) {
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
    }

    // Update password via admin API
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    );

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Update profile: clear force_password_change, update password_changed_at timestamp
    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({
        force_password_change: false,
        password_changed_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (profileErr) {
      return NextResponse.json(
        { error: "Password changed but session invalidation failed. Please contact admin." },
        { status: 500 }
      );
    }

    // Old-token revocation. password_changed_at is only enforced by the request
    // gates (src/proxy.ts, /api/auth/me) and those compare against the access
    // token's iat — a refresh token issued before the change still mints fresh
    // tokens. Revoke this user's refresh tokens upstream so tokens minted from
    // the old credential genuinely die. The caller's own session dies too, which
    // is the intended behaviour: after changing a password you sign in again.
    const accessToken =
      bearerToken ?? (await supabase.auth.getSession()).data.session?.access_token;
    let sessionsRevoked = false;
    if (accessToken) {
      const { error: signOutErr } = await supabaseAdmin.auth.admin.signOut(
        accessToken,
        "global",
      );
      sessionsRevoked = !signOutErr;
      if (signOutErr) {
        // Not fatal: the password is already changed, and password_changed_at is
        // set so the iat gates still reject the old access token until it
        // expires. Surfaced so an operator can force revocation out of band.
        logger.error(
          { operation: "auth_change_password", code: "global_signout_failed" },
          "Global sign-out failed after password change",
        );
      }
    }

    return NextResponse.json({ success: true, sessionsRevoked });
  } catch (e: any) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
