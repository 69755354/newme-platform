// RBAC: user (authenticated)
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

const LEGACY_COOKIE_NAMES = ["sb-access-token", "sb-refresh-token"];

/**
 * POST /api/auth/logout
 *
 * Clearing the cookies only ends the session in this browser. The refresh token
 * stays valid upstream for its full 30-day life until GoTrue is told otherwise,
 * so a copy taken from the machine keeps minting access tokens after the user
 * believes they signed out. Upstream revocation is therefore the part that
 * matters, and its result is reported rather than discarded.
 *
 * Why this route no longer calls `supabase.auth.signOut()`
 * -------------------------------------------------------
 * Because that call was doing nothing at all, and said so with `revoked: true`.
 * Measured, not reasoned: postdeploy acceptance signs a session in, calls this
 * endpoint, gets `{ok: true, revoked: true}`, then replays the *same* cookie
 * against `/api/auth/me` — and got HTTP 200, refusing the release with
 * `uat_sales_post_logout_credential_active`.
 *
 * The cause is a mismatch between how the server client carries its credential
 * and what auth-js checks. `createServerSupabase` injects the access token as a
 * global `Authorization` header and creates the client with
 * `persistSession: false`; `setSession()` is never called, so the client's
 * session storage is empty. auth-js `_signOut()` only performs the network
 * revocation `if (accessToken)`, reading it from that *stored* session — never
 * from the header — and otherwise returns `{error: null}` without making a
 * request. So `error` was always null, and `revoked: true` meant no more than
 * "cookies were cleared on this response".
 *
 * What runs instead is the mechanism this codebase already trusts and verifies
 * for administrator resets and self password changes: `revoke_user_sessions`,
 * a service-role-only definer function that deletes every `auth.sessions` and
 * `auth.refresh_tokens` row for the identity, re-reads to confirm none remain,
 * raises if it cannot get to that state, and audits the result
 * (supabase/migrations/20260817120000_admin_reset_session_revocation.sql; its
 * postconditions are asserted in supabase/replay/10_assert_release_contracts.sql).
 * It revokes globally, which is what a sign-out must mean: a sign-out that
 * leaves other copies of the refresh token alive is not a sign-out. It also
 * needs only the caller's user id, so it still works when the presented access
 * token has already expired and only the refresh cookie survives — the case a
 * bearer-token call to `/auth/v1/logout` cannot serve.
 *
 * Cookies are cleared unconditionally, including when revocation fails. Leaving
 * a session in the browser because the upstream call failed would be strictly
 * worse. The status code and `revoked` flag tell the caller which happened; the
 * login page uses this endpoint to discard a rejected session and treats any
 * outcome as "cookies gone", which stays correct.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  const names = getSupabaseCookieNames();
  const clearCookies = (response: NextResponse) => {
    for (const name of [names.authToken, names.refreshToken, ...LEGACY_COOKIE_NAMES]) {
      response.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
    return response;
  };

  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);

    // Identify the caller from the credential it presented. This is a real
    // upstream check: the client holds the token in its Authorization header, so
    // `getUser()` asks GoTrue, which validates both the JWT and its session row.
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;

    if (!userId) {
      // No credential, or one upstream already refuses. There is no identity to
      // revoke and nothing to fail: the cookies go and the answer says plainly
      // that no revocation was performed, rather than claiming one.
      return clearCookies(
        NextResponse.json({ ok: true, revoked: false, reason: "no_active_session" }),
      );
    }

    const { data: revocation, error: revokeError } = await supabaseAdmin.rpc(
      "revoke_user_sessions",
      { p_user_id: userId, p_reason: "self_logout" },
    );
    // `verified` is the function's own postcondition: it re-read the tables and
    // found nothing left. Absent or false, this release does not claim a
    // revocation happened.
    const revoked =
      !revokeError && (revocation as { verified?: boolean } | null)?.verified === true;

    if (!revoked) {
      logger.error(
        { request_id: requestId, operation: "auth_logout", code: "revocation_failed" },
        "Upstream session revocation failed during logout",
      );
      return clearCookies(
        NextResponse.json({ ok: false, revoked: false, error: "revocation_failed" }, { status: 502 }),
      );
    }

    return clearCookies(NextResponse.json({ ok: true, revoked: true }));
  } catch (err) {
    logger.error(
      { request_id: requestId, operation: "auth_logout", err },
      "Logout failed before upstream revocation",
    );
    return clearCookies(
      NextResponse.json({ ok: false, revoked: false }, { status: 500 }),
    );
  }
}
