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
      .select("role, is_active, force_password_change, full_name, email")
      .eq("id", user.id)
      .single();

    if (profileError) {
      logger.error({ request_id: requestId, operation: "auth_me", err: profileError });
      return respond({ error: "internal_error" }, { status: 500 });
    }

    if (!profile || profile.is_active !== true) {
      return respond({ error: "inactive_account" }, { status: 401 });
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
