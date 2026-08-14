// RBAC: user (admin, boss)
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";

// GET /api/users/[id]/password — Admin/boss view password hint
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));
    if (!["admin", "boss"].includes(context.role)) {
      return respond({ error: "Forbidden" }, { status: 403 });
    }

    const { data: target, error } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("id", targetId)
      .single();

    if (error || !target) {
      return respond({ error: "User not found" }, { status: 404 });
    }

    return respond({ hint: "Password was reset. User should check email or contact admin.", full_name: target.full_name });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
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
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));
    const { password } = await request.json();

    if (!password || password.length < 6) {
      return respond({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    // F-07: this endpoint is an admin/boss RESET path only. Self-service change
    // must prove ownership of the current password, which /api/auth/change-password
    // does via signInWithPassword before updating. Without that proof, anyone
    // holding a live session could permanently take over the account.
    if (targetId === "change-password") {
      return respond(
        { error: "Use POST /api/auth/change-password with oldPassword and newPassword" },
        { status: 400 }
      );
    }

    if (!["admin", "boss"].includes(context.role)) {
      return respond({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(targetId, { password });
    if (error) return respond({ error: error.message }, { status: 400 });

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

    // R2 · a failed timestamp write does not skip the revocation.
    //
    // This used to return 500 right here, before the RPC below ever ran. The
    // target's password had already been replaced by an administrator at that
    // point, so the one outcome where the live sessions are most certainly stale
    // was the one outcome that left them alone. The two writes protect different
    // things — the timestamp makes an already-minted access token fail the iat
    // check, the RPC deletes the refresh tokens that would mint a new one — so
    // the failure of the first is a reason to attempt the second, not to skip it.
    // The order is unchanged when both succeed.
    //
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
      return respond(
        {
          error:
            "Password changed, but the target's existing sessions could not be verifiably revoked. Treat the account as still signed in: retry, or ban the identity in Supabase Auth before relying on this reset.",
        },
        { status: 502 }
      );
    }

    if (profileErr) {
      return respond(
        {
          error:
            "Password changed and the existing sessions were revoked, but the audit timestamp could not be recorded. force_password_change is unset too, so repeat the reset to make the target replace this password.",
        },
        { status: 500 }
      );
    }

    return respond({ success: true });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
