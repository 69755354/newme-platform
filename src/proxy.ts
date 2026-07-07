import { NextResponse, NextRequest } from "next/server";
import { createMiddlewareClient } from "@/models/supabase-middleware";
import { reportServerError } from "@/services/report-server-error";

const PROTECTED_ROUTES: Record<string, string[]> = {
  "/settings": ["admin", "boss", "operator"],
  "/team": ["admin", "boss", "operator"],
  "/pipeline": ["admin", "boss", "operator"],
};

// Track user activity — update last_active_at, but throttle to once per 5 min per user
const activityThrottle = new Map<string, number>();

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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

  // Check if this path requires specific roles
  let requiredRoles: string[] | null = null;
  for (const [prefix, roles] of Object.entries(PROTECTED_ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      requiredRoles = roles;
      break;
    }
  }

  // Use createMiddlewareClient to validate session (no service_role needed)
  const { supabase, response } = createMiddlewareClient(request);

  let { data: { user } } = await supabase.auth.getUser();

  // Fallback: also check Authorization Bearer header (for localhost/dev testing,
  // where SSR cookies may fail to parse correctly)
  if (!user) {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        const { data: authUser } = await supabase.auth.getUser(token);
        user = authUser?.user ?? null;
      } catch {
        // fallback failed, user stays null
      }
    }
  }

  // Q6: Password reset session invalidation — if password was changed after the
  // JWT was issued, force re-login so stale tokens can't be used.
  if (user) {
    try {
      // Decode JWT iat claim from session
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (accessToken) {
        const payload = JSON.parse(
          Buffer.from(accessToken.split(".")[1], "base64url").toString(),
        );
        const jwtIat = payload.iat;
        if (jwtIat) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("password_changed_at")
            .eq("id", user.id)
            .single();
          if (profile?.password_changed_at) {
            const changedAt = Math.floor(
              new Date(profile.password_changed_at).getTime() / 1000,
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
      // If decoding fails, allow the request — don't block on parse errors
    }
  }

  // Track activity: update last_active_at (throttled to once per 5 min)
  // Also capture client IP for audit_log (x-forwarded-for → first IP)
  if (user && !pathname.startsWith("/_next") && !pathname.startsWith("/api")) {
    const now = Date.now();
    const last = activityThrottle.get(user.id) || 0;
    if (now - last > 300_000) {
      activityThrottle.set(user.id, now);
      const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || request.headers.get("x-real-ip")
        || "unknown";
      // Fire-and-forget: update profile activity + log IP audit
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
      supabase.from("audit_logs").insert({
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

  // No role check needed — pass through
  if (!requiredRoles) {
    return response;
  }

  // Not logged in — redirect to login
  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Fetch role from profiles using user's own session (no service_role needed)
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const userRole = profile?.role;

  if (!userRole || !requiredRoles.includes(userRole)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
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
    // P3_6 (PRD §六 6.5): legacy URL redirects at the edge.
    // /quotations has no :path* so /quotations/[id] stays reachable.
    "/command-center/:path*",
    "/quotations",
    // ROOT_WHITEPAGE_FIX (2026-07-05): bare "/" needs to be in matcher so proxy.ts
    // actually intercepts it (otherwise Next.js prerenders and serves the empty shell).
    "/",
  ],
};
