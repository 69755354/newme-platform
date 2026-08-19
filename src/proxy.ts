import { NextResponse, NextRequest } from "next/server";
import { createMiddlewareClient } from "@/lib/supabase-middleware";
import { reportServerError } from "@/lib/report-server-error";
import { shouldRecordActivity } from "@/lib/activity-throttle.mjs";
import { isActiveProfile } from "@/lib/auth-profile.mjs";
import {
  FORCED_SESSION_ERROR,
  FORCED_SESSION_REDIRECT_PATH,
  isForcedPasswordChange,
  isForcedSessionAllowedPath,
} from "@/lib/forced-password-change.mjs";

const PROTECTED_ROUTES: Record<string, string[]> = {
  "/settings": ["admin", "boss", "operator"],
  "/team": ["admin", "boss", "operator"],
  "/pipeline": ["admin", "boss", "operator"],
};

const PUBLIC_API_PATHS = new Set([
  // Pre-authentication by definition: the password grant is what creates a
  // session, so it can never require one. It rate-limits and origin-checks
  // itself, and never sets cookies for a profile that fails the active gate.
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
]);
const SESSION_BOOTSTRAP_PATH = "/api/auth/session";
const EXTERNAL_AUTHORIZED_API_PATHS = new Set([
  "/api/health",
  "/api/ready",
  "/api/monitoring/report",
  "/api/leads/meta-capi",
  "/api/meta/oauth-callback",
]);
const EXTERNAL_AUTHORIZED_API_PREFIXES = ["/api/cron/"];
const AUTH_TIMEOUT_MS = 3_000;

type ActiveProfile = {
  role?: string | null;
  is_active?: boolean | null;
  password_changed_at?: string | null;
  force_password_change?: boolean | null;
};

function isExternalAuthorizedApi(pathname: string): boolean {
  return EXTERNAL_AUTHORIZED_API_PATHS.has(pathname)
    || EXTERNAL_AUTHORIZED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isProtectedApiMutation(request: NextRequest, pathname: string): boolean {
  return pathname.startsWith("/api/")
    && !["GET", "HEAD", "OPTIONS"].includes(request.method)
    && !PUBLIC_API_PATHS.has(pathname)
    && pathname !== SESSION_BOOTSTRAP_PATH
    && !isExternalAuthorizedApi(pathname);
}

async function withAuthTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("auth_timeout")), AUTH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function authUnavailable(request: NextRequest, isApiRequest: boolean) {
  if (isApiRequest) {
    return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("reason", "auth_unavailable");
  return NextResponse.redirect(loginUrl);
}

// Track user activity — update last_active_at, but throttle to once per 5 min
// per user. The bookkeeping lives in @/lib/activity-throttle: it used to be a
// `Map<string, number>` here that was only ever written to, so it retained one
// entry per user id for the life of the process to enforce a 5-minute window
// (R8). The write itself stays in this file — tests/security/
// profiles-grant-coupling.test.mjs requires the proxy to be the only
// caller-scoped writer of public.profiles.
const ACTIVITY_WINDOW_MS = 300_000;

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname.startsWith("/api/");
  const isPublicApiRequest = isApiRequest && (PUBLIC_API_PATHS.has(pathname) || pathname === SESSION_BOOTSTRAP_PATH);
  const protectedApiMutation = isProtectedApiMutation(request, pathname);

  // P3_6 (PRD §六 6.5): legacy URL redirects — return early so we don't run auth.
  // /command-center → /dashboard
  // /quotations (only the bare path; /quotations/[id] stays)
  if (pathname === "/command-center" || pathname.startsWith("/command-center/")) {
    return NextResponse.redirect(new URL("/dashboard", request.url), 307);
  }
  if (pathname === "/quotations") {
    return NextResponse.redirect(new URL("/quotes", request.url), 307);
  }

  // ROOT_WHITEPAGE_FIX (2026-07-05): bare "/" triggers Next.js 16
  // BAILOUT_TO_CLIENT_SIDE_RENDERING and renders an empty shell, causing a
  // 1-3s white flash before client-side redirect kicks in. Force HTTP 307
  // at the edge so the browser never sees the empty shell.
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url), 307);
  }

  // Session bootstrap and introspection own their authentication behavior;
  // never make them unavailable because proxy-side session refresh is slow.
  if (isPublicApiRequest) {
    return NextResponse.next();
  }

  // Check if this path requires specific roles
  let requiredRoles: string[] | null = null;
  for (const [prefix, roles] of Object.entries(PROTECTED_ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      requiredRoles = roles;
      break;
    }
  }

  // Resolve credentials once, with the same Bearer-first precedence used by
  // createServerSupabase in route handlers. The old cookie-first/fallback flow
  // could authorize cookie user A here and then execute as Bearer user B below.
  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.match(/^Bearer\s+([^\s]+)$/i)?.[1];

  // Use createMiddlewareClient to validate session (no service_role needed).
  let middlewareClient: Awaited<ReturnType<typeof createMiddlewareClient>>;
  try {
    middlewareClient = await withAuthTimeout(createMiddlewareClient(request, bearerToken));
  } catch {
    return authUnavailable(request, isApiRequest);
  }
  const { supabase, getResponse } = middlewareClient;

  let user: { id: string } | null = null;
  let authInfrastructureFailed = false;
  try {
    const { data } = await withAuthTimeout(supabase.auth.getUser(bearerToken));
    user = data.user;
  } catch {
    authInfrastructureFailed = true;
  }

  if (!user && protectedApiMutation) {
    return authInfrastructureFailed
      ? authUnavailable(request, true)
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let activeProfile: ActiveProfile | null = null;

  // Server-side session revocation boundary. Auth access tokens are not assumed
  // to become invalid when a profile is deactivated; every protected request
  // must still prove that its profile is active.
  if (user && !isPublicApiRequest) {
    // When the user was resolved via the Bearer fallback, query their own
    // profile with that same JWT. The profiles self-select RLS policy is the
    // authorization boundary, so login and request authentication never
    // depend on an independently rotated service-role key.
    let profile: ActiveProfile | null = null;
    let profileErr: unknown = null;

    if (bearerToken) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !publishableKey || !bearerToken) {
        profileErr = new Error("missing_user_scoped_profile_env");
      } else {
        try {
          const res = await withAuthTimeout(fetch(
            `${supabaseUrl}/rest/v1/profiles?select=id,is_active,role,password_changed_at,force_password_change&id=eq.${user.id}`,
            {
              headers: {
                apikey: publishableKey,
                Authorization: `Bearer ${bearerToken}`,
              },
            },
          ));
          if (!res.ok) {
            profileErr = new Error(`profiles_rest_${res.status}`);
          } else {
            const profiles = await res.json();
            profile = Array.isArray(profiles) && profiles.length > 0
              ? profiles[0]
              : null;
          }
        } catch (err) {
          profileErr = err;
        }
      }
    } else {
      const { data, error } = await withAuthTimeout(supabase
        .from("profiles")
        .select("role, is_active, password_changed_at, force_password_change")
        .eq("id", user.id)
        .single());
      profile = data;
      profileErr = error;
    }

    if (profileErr) {
      return authUnavailable(request, isApiRequest);
    }
    if (!isActiveProfile(profile)) {
      if (isApiRequest) {
        return NextResponse.json({ error: "inactive_account" }, { status: 401 });
      }
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("reason", "inactive_account");
      return NextResponse.redirect(loginUrl);
    }
    activeProfile = profile;

    // A2: a forced session may change its password, look at itself and leave.
    // Everything else — reads included, and every service-role route with it —
    // is refused here, before the request reaches a handler. The exceptions live
    // in one list in src/lib/forced-password-change.mjs so this boundary and
    // getRequestAuthContext() cannot disagree about what they are.
    if (isForcedPasswordChange(profile) && !isForcedSessionAllowedPath(pathname)) {
      if (isApiRequest) {
        return NextResponse.json({ error: FORCED_SESSION_ERROR }, { status: 403 });
      }
      const changeUrl = new URL(FORCED_SESSION_REDIRECT_PATH, request.url);
      changeUrl.searchParams.set("reason", FORCED_SESSION_ERROR);
      return NextResponse.redirect(changeUrl);
    }
  }

  // Q6: Password reset session invalidation — if password was changed after the
  // JWT was issued, force re-login so stale tokens can't be used.
  if (user) {
    try {
      // Decode JWT iat claim from session
      const accessToken = bearerToken ?? (await withAuthTimeout(supabase.auth.getSession())).data.session?.access_token;
      if (accessToken) {
        const payload = JSON.parse(
          Buffer.from(accessToken.split(".")[1], "base64url").toString(),
        );
        const jwtIat = payload.iat;
        if (jwtIat) {
          if (activeProfile?.password_changed_at) {
            const changedAt = Math.floor(
              new Date(activeProfile.password_changed_at).getTime() / 1000,
            );
            if (changedAt > jwtIat) {
              const loginUrl = new URL("/login", request.url);
              loginUrl.searchParams.set(
                "reason",
                "password_changed",
              );
              return NextResponse.redirect(loginUrl);
            }
          }
        }
      }
    } catch {
      if (protectedApiMutation) return authUnavailable(request, true);
    }
  }

  // Track activity: update last_active_at (throttled to once per 5 min).
  // The client-IP capture that used to accompany this existed only to populate
  // the audit row below; see the note there.
  if (user && !pathname.startsWith("/_next") && !pathname.startsWith("/api")) {
    if (shouldRecordActivity(user.id, ACTIVITY_WINDOW_MS)) {
      // Fire-and-forget: update profile activity.
      supabase.from("profiles").update({ last_active_at: new Date().toISOString() }).eq("id", user.id).then(({ error }) => {
        if (error) {
          // Production monitoring requirement - report server errors
          reportServerError({
            message: error.message,
            type: "activity_tracking_error",
            url: pathname,
          }).catch(() => {
            // Silent fail to prevent circular reporting
          });
          console.error("Activity tracking error:", error.message);
        }
      });
      // The PAGE_VISIT insert into audit_logs that used to sit here has been
      // removed. It wrote to audit_logs with the CALLER'S OWN RLS client, which
      // is why the table needed a permissive `WITH CHECK (true)` INSERT policy
      // for `authenticated` — and that policy let any user forge an audit entry
      // under any actor_id (F-08). audit_logs is now server-write-only
      // (20260811100000_f08_audit_logs_actor_identity.sql), matching the
      // "server-owned evidence, never browser-submitted facts" rule that
      // 20260723130000_lock_definer_boundaries.sql already set.
      //
      // Nothing read these rows: they were page telemetry, not audit evidence.
      // last_active_at above still carries the activity signal. If page-visit
      // telemetry is wanted back, it has to be written server-side with
      // supabaseAdmin — the service-role key must not enter this runtime.
    }
  }

  // No role check needed — pass through
  if (!requiredRoles) {
    return getResponse();
  }

  // Not logged in — redirect to login
  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const userRole = activeProfile?.role;

  if (!userRole || !requiredRoles.includes(userRole)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return getResponse();
}

export const config = {
  matcher: [
    "/settings/:path*",
    "/team/:path*",
    "/pipeline/:path*",
    "/dashboard/:path*",
    "/leads/:path*",
    "/contracts/:path*",
    "/analytics/:path*",
    "/ads/:path*",
    "/quotes/:path*",
    "/projects/:path*",
    "/products/:path*",
    // /cable-costing is an authenticated employee tool under src/app/(dashboard);
    // listing it keeps the edge checks (is_active revocation, forced-password-change
    // refusal) in front of both the page and any server action posted to its path.
    // It is deliberately NOT in PROTECTED_ROUTES: every signed-in role may use it.
    "/cable-costing/:path*",
    // A2: /payments, /tasks and /workbench are authenticated pages under
    // src/app/(dashboard) that this matcher never listed, so no edge check ran
    // for them — neither the forced-password-change refusal added below nor the
    // older is_active revocation boundary. Server actions POST to the page's own
    // path, so an unlisted page was also an unchecked action entry point.
    // tests/security/forced-password-change-boundary.test.mjs asserts that every
    // page under (dashboard) is covered, so a new page cannot reopen this.
    "/payments/:path*",
    "/tasks/:path*",
    "/workbench/:path*",
    "/api/:path*",
    // P3_6 (PRD §六 6.5): legacy URL redirects at the edge.
    // /quotations has no :path* so /quotations/[id] stays reachable.
    "/command-center/:path*",
    "/quotations",
    // ROOT_WHITEPAGE_FIX (2026-07-05): bare "/" needs to be in matcher so proxy.ts
    // actually intercepts it (otherwise Next.js prerenders and serves the empty shell).
    "/",
  ],
};
