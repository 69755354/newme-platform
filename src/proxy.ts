import { NextResponse, NextRequest } from "next/server";
import { createMiddlewareClient } from "@/lib/supabase-middleware";

/**
 * P1-1 Route Guard (Next.js 16 `proxy.ts` — the renamed middleware).
 *
 * Two layers of protection:
 *   1. AUTH GATE  — every dashboard page requires a valid Supabase session.
 *                  Anonymous users are redirected to /login (with ?redirect=).
 *                  API routes (/api/*) are excluded: they enforce auth and
 *                  must return 401 JSON, not an HTML redirect.
 *   2. ROLE GATE  — management-only routes require admin/boss/operator.
 *
 * `proxy` is the Next.js 16 successor to the deprecated `middleware` export.
 * The runtime is `nodejs` (edge is unsupported in proxy).
 */

// Routes that require a SPECIFIC role (management-only).
const PROTECTED_ROUTES: Record<string, string[]> = {
  "/settings": ["admin", "boss", "operator"],
  "/team": ["admin", "boss", "operator"],
  "/pipeline": ["admin", "boss", "operator"],
  "/analytics": ["admin", "boss", "operator"],
  "/ads": ["admin", "boss", "operator"],
  "/products": ["admin", "boss", "operator"],
  "/projects": ["admin", "boss", "operator"],
  "/games": ["admin", "boss", "operator"],
};

// Every dashboard page prefix — all require an authenticated session.
// (API routes intentionally excluded — see header comment.)
const AUTH_REQUIRED_PREFIXES = [
  "/dashboard",
  "/leads",
  "/contracts",
  "/quotes",
  "/payments",
  "/projects",
  "/products",
  "/analytics",
  "/ads",
  "/pipeline",
  "/team",
  "/settings",
  "/games",
];

// Track user activity — update last_active_at, but throttle to once per 5 min per user
const activityThrottle = new Map<string, number>();

function isDashboardPage(pathname: string): boolean {
  return AUTH_REQUIRED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

function getRequiredRoles(pathname: string): string[] | null {
  for (const [prefix, roles] of Object.entries(PROTECTED_ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return roles;
    }
  }
  return null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const requiredRoles = getRequiredRoles(pathname);
  const needsAuth = isDashboardPage(pathname);

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
        if (error) console.error("Activity tracking error:", error.message);
      });
      supabase.from("audit_logs").insert({
        actor_id: user.id,
        action: "PAGE_VISIT",
        details: { page: pathname },
        ip_address: clientIp,
      }).then(({ error }) => {
        if (error) console.error("Audit log error:", error.message);
      });
    }
  }

  // ── AUTH GATE ── any dashboard page without a session → /login
  if (needsAuth && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // No role restriction beyond "must be logged in" → pass through
  if (!requiredRoles || !user) {
    return response;
  }

  // ── ROLE GATE ── fetch role from profiles using the user's own session
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
    "/payments/:path*",
    "/projects/:path*",
    "/products/:path*",
    "/games/:path*",
    "/api/:path*",
  ],
};
