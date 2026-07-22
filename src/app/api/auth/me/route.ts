// RBAC: user (authenticated)
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase, getRefreshedCookies, getRefreshAttempted, getRefreshFailure } from "@/lib/supabase-server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

const LEGACY_COOKIE_NAMES = ["sb-access-token", "sb-refresh-token"];

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
        return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
      }

      const response = NextResponse.json(
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

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      logger.error({
        request_id: requestId,
        operation: "auth_me",
        err: new Error("missing environment: SUPABASE_URL or SERVICE_ROLE_KEY"),
      });
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role, is_active, force_password_change, full_name, email")
      .eq("id", user.id)
      .single();

    if (profileError) {
      logger.error({ request_id: requestId, operation: "auth_me", err: profileError });
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    if (!profile || profile.is_active !== true) {
      return NextResponse.json({ error: "inactive_account" }, { status: 401 });
    }

    const role = profile.role ?? "sales";

    const response = NextResponse.json({
      userId: user.id,
      email: user.email ?? null,
      role,
      isActive: profile?.is_active === true,
      forcePasswordChange: profile.force_password_change ?? false,
      fullName: profile.full_name ?? null,
    });
    for (const c of refreshedCookies) {
      response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
    }
    return response;
  } catch (err) {
    logger.error({ request_id: requestId, operation: "auth_me", err });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}