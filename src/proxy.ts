import { NextResponse, NextRequest } from "next/server";
import { createMiddlewareClient } from "@/lib/supabase-middleware";
import { reportServerError } from "@/lib/report-server-error";
import { isActiveProfile } from "@/lib/auth-profile.mjs";

const PROTECTED_ROUTES: Record<string, string[]> = {
  "/settings": ["admin", "boss", "operator"],
  "/team": ["admin", "boss", "operator"],
  "/pipeline": ["admin", "boss", "operator"],
};

const PUBLIC_API_PATHS = new Set([
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

// Track user activity 鈥?update last_active_at, but throttle to once per 5 min per user
const activityThrottle = new Map<string, number>();

async function writeServerEvidence(
  table: "profiles" | "audit_logs",
  query: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !secretKey) {
    return { error: new Error("staging server evidence client is not configured") };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ""}`,
      {
        method,
        headers: {
          apikey: secretKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(body),
      },
    );
    return {
      error: response.ok
        ? null
        : new Error(`server evidence write returned HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error("server evidence write failed"),
    };
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname.startsWith("/api/");
  const isPublicApiRequest = isApiRequest && (PUBLIC_API_PATHS.has(pathname) || pathname === SESSION_BOOTSTRAP_PATH);
  const protectedApiMutation = isProtectedApiMutation(request, pathname);

  // P3_6 (PRD 搂鍏?6.5): legacy URL redirects 鈥?return early so we don't run auth.
  // /command-center 鈫?/dashboard
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

  // Use createMiddlewareClient to validate session (no service_role needed)
  let middlewareClient: Awaited<ReturnType<typeof createMiddlewareClient>>;
  try {
    middlewareClient = await withAuthTimeout(createMiddlewareClient(request));
  } catch {
    return authUnavailable(request, isApiRequest);
  }
  const { supabase, getResponse } = middlewareClient;

  let user: { id: string } | null = null;
  let authInfrastructureFailed = false;
  try {
    const { data } = await withAuthTimeout(supabase.auth.getUser());
    user = data.user;
  } catch {
    authInfrastructureFailed = true;
  }

  // Fallback: also check Authorization Bearer header (for localhost/dev testing,
  // where SSR cookies may fail to parse correctly)
  let usedBearerFallback = false;
  let bearerToken: string | undefined;
  if (!user) {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      bearerToken = token;
      try {
        const { data: authUser } = await withAuthTimeout(supabase.auth.getUser(token));
        user = authUser?.user ?? null;
        if (user) {
          usedBearerFallback = true;
        }
      } catch {
        authInfrastructureFailed = true;
      }
    }
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
    // SAM-51: When the user was resolved via the Bearer fallback above, the
    // cookie-driven middleware client has no auth context for them, so a
    // profiles query through it runs as anon and gets RLS-rejected (returning
    // empty/inactive). Query profiles via the Supabase REST API with the
    // service_role key to bypass RLS. createClient(url, service_role_key) is
    // intentionally avoided 鈥?it 500s under the Edge Runtime.
    let profile: ActiveProfile | null = null;
    let profileErr: unknown = null;

    if (usedBearerFallback) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRoleKey) {
        profileErr = new Error("missing_service_role_env");
      } else {
        try {
          const res = await withAuthTimeout(fetch(
            `${supabaseUrl}/rest/v1/profiles?select=id,is_active,role,password_changed_at&id=eq.${user.id}`,
            {
              headers: {
                apikey: serviceRoleKey,
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
        .select("role, is_active, password_changed_at")
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
  }

  // Q6: Password reset session invalidation 鈥?if password was changed after the
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

  // Track activity: update last_active_at (throttled to once per 5 min)
  // Also capture client IP for audit_log (x-forwarded-for 鈫?first IP)
  if (user && !pathname.startsWith("/_next") && !pathname.startsWith("/api")) {
    const now = Date.now();
    const last = activityThrottle.get(user.id) || 0;
    if (now - last > 300_000) {
      activityThrottle.set(user.id, now);
      const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || request.headers.get("x-real-ip")
        || "unknown";
      // Fire-and-forget: update profile activity + log IP audit
      writeServerEvidence(
        "profiles",
        `id=eq.${encodeURIComponent(user.id)}`,
        "PATCH",
        { last_active_at: new Date().toISOString() },
      ).then(({ error }) => {
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
      writeServerEvidence("audit_logs", "", "POST", {
        // NOTE: audit_logs.actor_id is the genuine column (NOT a business_events alias).
        // Migration 20260613000000_audit_logs.sql:6 declares it. Unlike business_events
        // (where actor_id was the wrong alias), audit_logs always used actor_id. Do NOT rename.
        actor_id: user.id,
        action: "PAGE_VISIT",
        details: { page: pathname },
        ip_address: clientIp,
      }).then(({ error }) => {
        if (error) {
          // Production monitoring requirement - report server errors
          reportServerError({
            message: error.message,
            type: "audit_log_error",
            url: pathname,
          }).catch(() => {
            // Silent fail to prevent circular reporting
          });
          console.error("Audit log error:", error.message);
        }
      });
    }
  }

  // No role check needed 鈥?pass through
  if (!requiredRoles) {
    return getResponse();
  }

  // Not logged in 鈥?redirect to login
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
    "/api/:path*",
    // P3_6 (PRD 搂鍏?6.5): legacy URL redirects at the edge.
    // /quotations has no :path* so /quotations/[id] stays reachable.
    "/command-center/:path*",
    "/quotations",
    // ROOT_WHITEPAGE_FIX (2026-07-05): bare "/" needs to be in matcher so proxy.ts
    // actually intercepts it (otherwise Next.js prerenders and serves the empty shell).
    "/",
  ],
};

