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

    // R2 · the same asymmetry this route's own error string described.
    //
    // A failed profiles update returned 500 here and said "session invalidation
    // failed" — while the global sign-out below, the step that actually
    // invalidates the sessions, had not been attempted yet. The password is
    // already changed at this point; the old credential's tokens have to go
    // whether or not the timestamp landed. So the sign-out runs first now and the
    // profile failure is reported afterwards, with what it actually costs.
    //
    // Old-token revocation. password_changed_at is only enforced by the request
    // gates (src/proxy.ts, /api/auth/me) and those compare against the access
    // token's iat — a refresh token issued before the change still mints fresh
    // tokens. Revoke this user's refresh tokens upstream so tokens minted from
    // the old credential genuinely die. The caller's own session dies too, which
    // is the intended behaviour: after changing a password you sign in again.
    const { data: revocation, error: revokeError } = await supabaseAdmin.rpc(
      "revoke_user_sessions",
      { p_user_id: user.id, p_reason: "self_password_change" },
    );
    const sessionsRevoked =
      !revokeError && (revocation as { verified?: boolean } | null)?.verified === true;
    if (!sessionsRevoked) {
      logger.error(
        { operation: "auth_change_password", code: "session_revocation_unverified" },
        "Password changed but session revocation was not verified",
      );
    }

    if (profileErr) {
      // force_password_change is still true, so the A2 boundary keeps this
      // session on the change-password page and the next attempt can succeed;
      // password_changed_at is still old, so the iat gates do not help. Both are
      // reported rather than summarised as "contact admin".
      logger.error(
        { operation: "auth_change_password", code: "profile_update_failed", sessionsRevoked },
        "Password changed but profiles.password_changed_at/force_password_change were not updated",
      );
      return NextResponse.json(
        {
          success: false,
          passwordChanged: true,
          sessionsRevoked,
          profileUpdated: false,
          error: sessionsRevoked
            ? "Password changed and existing sessions were revoked, but the account record was not updated. Sign in with the new password and change it again."
            : "Password changed, but neither the account record nor the existing sessions could be updated. Sign in again and change the password once more.",
        },
        { status: 500 }
      );
    }

    if (!sessionsRevoked) {
      // The password is already changed, but returning success here tells both
      // callers that the old refresh-token family is gone when it is not. Make
      // the partial completion explicit and fail closed so the UI cannot treat
      // revocation failure as a completed security action.
      return NextResponse.json(
        {
          success: false,
          error: "Password changed, but existing sessions could not be revoked. Sign in with the new password and contact an administrator.",
          code: "session_revocation_failed",
          passwordChanged: true,
          sessionsRevoked: false,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, sessionsRevoked: true });
  } catch (e: any) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
