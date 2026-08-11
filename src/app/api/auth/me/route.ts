// RBAC: user (authenticated)
import { createServerSupabase, getRefreshedCookies, getRefreshAttempted, getRefreshFailure } from "@/lib/supabase-server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

const LEGACY_COOKIE_NAMES = ["sb-access-token", "sb-refresh-token"];
const PRIVATE_NO_STORE = "private, no-store, max-age=0, must-revalidate";

function applyPrivateNoStore(response: NextResponse) {
  response.headers.set("Cache-Control", PRIVATE_NO_STORE);
  response.headers.set("Vary", "Cookie, Authorization");
  return response;
}

function clearSessionCookies(response: NextResponse) {
  const names = getSupabaseCookieNames();
  for (const name of [names.authToken, names.refreshToken, ...LEGACY_COOKIE_NAMES]) {
    response.cookies.set(name, "", { path: "/", maxAge: 0 });
  }
}

/**
 * `iat` of the access token the CALLER presented, before any refresh this route
 * performs. Returns null when no access token was presented (its cookie has a
 * one-hour max-age, so a returning browser legitimately sends only the refresh
 * half) or when the token is unparseable.
 */
function presentedTokenIssuedAt(bearerToken: string | undefined, cookieHeader: string): number | null {
  let token = bearerToken;
  if (!token) {
    const { authToken } = getSupabaseCookieNames();
    const match = cookieHeader.match(
      new RegExp(`(?:^|;\\s*)${authToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`),
    );
    if (!match) return null;
    try {
      const parsed = JSON.parse(decodeURIComponent(match[1]));
      token = typeof parsed?.access_token === "string" ? parsed.access_token : undefined;
    } catch {
      return null;
    }
  }
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof payload?.iat === "number" ? payload.iat : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/auth/me — returns current user info from session cookie.
 * Used by dashboard layout to avoid client-side Supabase dependency.
 *
 * Cookies are extracted from the Request object explicitly and passed to
 * createServerSupabase via cookieString, avoiding the implicit next/headers
 * cookies() API. This ensures the route works regardless of how node_modules
 * is resolved (source repo, frozen copy, or any other path).
 */
export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const bearerToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const refreshedCookies = getRefreshedCookies(supabase);
    const refreshAttempted = getRefreshAttempted(supabase);
    const refreshFailure = getRefreshFailure(supabase);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) => {
      const response = applyPrivateNoStore(NextResponse.json(body, init));
      for (const cookie of refreshedCookies) {
        response.cookies.set(
          cookie.name,
          cookie.value,
          cookie.options as Parameters<typeof response.cookies.set>[2],
        );
      }
      return response;
    };

    const {
      data: { user },
      error: authError,
    } = bearerToken
      ? await supabase.auth.getUser(bearerToken)
      : await supabase.auth.getUser();

    // Invalid or missing session → 401
    if (!user || authError) {
      if (refreshFailure === "upstream_error") {
        logger.error(
          { request_id: requestId, operation: "auth_refresh", code: "refresh_upstream_failure" },
          "Refresh token upstream failure",
        );
        return respond({ error: "auth_unavailable" }, { status: 503 });
      }

      const response = respond(
        refreshFailure || (refreshAttempted && refreshedCookies.length === 0)
          ? { success: false, error: { code: "UNAUTHORIZED", message: "Token refresh failed" } }
          : { error: "unauthorized" },
        { status: 401 },
      );
      if (refreshFailure === "invalid_refresh_token" || refreshFailure === "missing_refresh_token") {
        clearSessionCookies(response);
      }
      return response;
    }

    // Read the current user's own profile through RLS. Authentication must not
    // depend on a privileged service-role key that can be rotated independently.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role, is_active, force_password_change, full_name, email, password_changed_at")
      .eq("id", user.id)
      .single();

    if (profileError) {
      logger.error({ request_id: requestId, operation: "auth_me", err: profileError });
      return respond({ error: "internal_error" }, { status: 500 });
    }

    if (!profile || profile.is_active !== true) {
      return respond({ error: "inactive_account" }, { status: 401 });
    }

    // Password-reset revocation, enforced here and not only in src/proxy.ts.
    //
    // This path is listed in PUBLIC_API_PATHS, so proxy() returns
    // NextResponse.next() at src/proxy.ts:103 and the password_changed_at gate at
    // src/proxy.ts:227-255 never runs for it. But this route DOES refresh the
    // session and write the new cookies onto its response. That made it a token
    // laundry: an attacker holding a session whose password an administrator had
    // just reset could call GET /api/auth/me, receive a brand-new access token
    // whose iat is later than password_changed_at, and then pass the proxy gate
    // on every subsequent request. One call to a public endpoint defeated the
    // reset permanently.
    //
    // The comparison uses the iat of the token the caller PRESENTED, not the
    // refreshed one, whose iat is `now` by construction. Refreshed cookies are
    // withheld and the session is cleared, so the laundering attempt ends the
    // session instead of renewing it.
    //
    // Residual, deliberately documented rather than papered over: when the
    // access-token cookie has already expired (max-age 3600) the caller presents
    // only a refresh token and there is nothing to date the session with, so this
    // gate cannot fire. That window is closed at the source instead —
    // /api/auth/change-password now performs a global upstream sign-out, which
    // kills the refresh tokens themselves. An ADMIN-initiated reset
    // (/api/users/[id]/password) cannot do the same, because GoTrue's
    // admin.signOut requires the target user's own JWT; that gap is tracked as
    // PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION.
    if (profile.password_changed_at) {
      const presentedIat = presentedTokenIssuedAt(bearerToken, cookieHeader);
      const changedAt = Math.floor(new Date(profile.password_changed_at).getTime() / 1000);
      if (presentedIat !== null && Number.isFinite(changedAt) && changedAt > presentedIat) {
        const response = applyPrivateNoStore(
          NextResponse.json({ error: "password_changed" }, { status: 401 }),
        );
        clearSessionCookies(response);
        return response;
      }
    }

    const role = profile.role ?? "sales";

    return respond({
      userId: user.id,
      email: user.email ?? null,
      role,
      isActive: profile?.is_active === true,
      forcePasswordChange: profile.force_password_change ?? false,
      fullName: profile.full_name ?? null,
    });
  } catch (err) {
    logger.error({ request_id: requestId, operation: "auth_me", err });
    return applyPrivateNoStore(
      NextResponse.json({ error: "internal_error" }, { status: 500 }),
    );
  }
}
