// RBAC: public (pre-authentication)
import { NextResponse } from "next/server";
import { isActiveProfile } from "@/lib/auth-profile.mjs";
import { logger } from "@/lib/logger";
import { clientIdentifier, consumeRateLimit } from "@/lib/rate-limit";
import {
  applySessionCookies,
  hasAllowedSessionOrigin,
  normalizeExpiresIn,
} from "@/lib/session-cookies";

/**
 * POST /api/auth/login - server-side password grant.
 *
 * The browser previously authenticated against Supabase Auth directly and then
 * made two more same-origin calls to establish and validate the cookie session:
 * three serial round trips, the first of which left the CDN edge entirely and
 * paid a cold TLS handshake to the Auth region. This endpoint performs all three
 * server side over warm origin-to-Supabase connections, so the browser makes a
 * single request over its existing edge connection.
 *
 * The security boundary is unchanged, just enforced here instead of in the
 * client: an inactive profile never receives cookies, and the token freshly
 * issued to it is revoked upstream before this request returns.
 */

const AUTH_UPSTREAM_TIMEOUT_MS = 8_000;

// Server-side authentication funnels every user through the origin IP, which
// would otherwise collapse upstream per-IP brute-force protection into one
// bucket. Bound both the source address and the targeted account.
const PER_IP_LIMIT = { limit: 20, windowMs: 5 * 60_000 };
const PER_ACCOUNT_LIMIT = { limit: 8, windowMs: 15 * 60_000 };

const PRIVATE_NO_STORE = "private, no-store, max-age=0, must-revalidate";

function respond(body: Record<string, unknown>, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", PRIVATE_NO_STORE);
  response.headers.set("Vary", "Cookie, Authorization");
  return response;
}

/** Revoke a token we refuse to hand out. Failure is not fatal: no cookie was set. */
async function revokeIssuedToken(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(AUTH_UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // The proxy-side active-profile gate still rejects the token on every
    // subsequent request even when upstream revocation is unavailable.
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  const contentType = request.headers.get("content-type")?.split(";")[0].trim();
  if (contentType !== "application/json") {
    return respond({ error: "invalid_content_type" }, { status: 415 });
  }
  if (!hasAllowedSessionOrigin(request)) {
    return respond({ error: "invalid_origin" }, { status: 403 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    logger.error({ request_id: requestId, operation: "auth_login", code: "missing_auth_env" });
    return respond({ error: "auth_unavailable" }, { status: 503 });
  }

  let email = "";
  let password = "";
  try {
    const body = await request.json();
    email = typeof body?.email === "string" ? body.email.trim() : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return respond({ error: "invalid_request" }, { status: 400 });
  }
  if (!email || !password) {
    return respond({ error: "invalid_request" }, { status: 400 });
  }
  // Bound the credential fields before they reach the limiter or upstream. The
  // account limiter key is derived from `email`, and the password is forwarded
  // to the grant endpoint; neither should accept a megabyte of caller-controlled
  // input. RFC 5321 caps an address at 254 octets, and no legitimate password is
  // longer than bcrypt's own 72-byte input limit by more than a wide margin.
  if (email.length > 254 || password.length > 1024) {
    return respond({ error: "invalid_request" }, { status: 400 });
  }

  const ip = clientIdentifier(request);
  const ipLimit = consumeRateLimit(`login:ip:${ip}`, PER_IP_LIMIT);
  const accountLimit = consumeRateLimit(
    `login:account:${email.toLowerCase()}`,
    PER_ACCOUNT_LIMIT,
  );
  if (!ipLimit.allowed || !accountLimit.allowed) {
    const retryAfter = Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds);
    logger.warn({
      request_id: requestId,
      operation: "auth_login",
      code: "rate_limited",
      scope: !ipLimit.allowed ? "ip" : "account",
    });
    const response = respond({ error: "rate_limited" }, { status: 429 });
    response.headers.set("Retry-After", String(retryAfter));
    return response;
  }

  // 1. Password grant, server side.
  let grant: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: { id?: string; email?: string | null };
  };
  try {
    const grantRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, gotrue_meta_security: {} }),
      signal: AbortSignal.timeout(AUTH_UPSTREAM_TIMEOUT_MS),
    });
    if (!grantRes.ok) {
      // Upstream failure text can echo the submitted credential, so it is never
      // forwarded or logged. Every rejected credential gets one generic answer.
      if (grantRes.status >= 500) {
        logger.error({
          request_id: requestId,
          operation: "auth_login",
          code: "grant_upstream_error",
          status: grantRes.status,
        });
        return respond({ error: "auth_unavailable" }, { status: 503 });
      }
      return respond({ error: "invalid_credentials" }, { status: 401 });
    }
    grant = await grantRes.json();
  } catch (err) {
    logger.error({
      request_id: requestId,
      operation: "auth_login",
      code: "grant_unreachable",
      err: err instanceof Error ? err.name : "unknown",
    });
    return respond({ error: "auth_unavailable" }, { status: 503 });
  }

  const accessToken = grant.access_token;
  const refreshToken = grant.refresh_token;
  const userId = grant.user?.id;
  if (!accessToken || !refreshToken || !userId) {
    return respond({ error: "invalid_credentials" }, { status: 401 });
  }

  // 2. Active-profile gate, read through the caller own RLS identity using the
  // token just issued. Authentication never depends on the service-role key.
  let profile: {
    is_active?: boolean | null;
    role?: string | null;
    full_name?: string | null;
    force_password_change?: boolean | null;
  } | null = null;
  const profileQuery = "select=is_active,role,full_name,force_password_change";
  try {
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?${profileQuery}&id=eq.${encodeURIComponent(userId)}`,
      {
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(AUTH_UPSTREAM_TIMEOUT_MS),
      },
    );
    if (!profileRes.ok) {
      logger.error({
        request_id: requestId,
        operation: "auth_login",
        code: "profile_read_failed",
        status: profileRes.status,
      });
      await revokeIssuedToken(supabaseUrl, anonKey, accessToken);
      return respond({ error: "auth_unavailable" }, { status: 503 });
    }
    const rows = await profileRes.json();
    profile = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (err) {
    logger.error({
      request_id: requestId,
      operation: "auth_login",
      code: "profile_unreachable",
      err: err instanceof Error ? err.name : "unknown",
    });
    await revokeIssuedToken(supabaseUrl, anonKey, accessToken);
    return respond({ error: "auth_unavailable" }, { status: 503 });
  }

  if (!isActiveProfile(profile)) {
    await revokeIssuedToken(supabaseUrl, anonKey, accessToken);
    return respond({ error: "inactive_account" }, { status: 403 });
  }

  // 3. Only now does a session exist. Cookies come from the shared contract.
  return applySessionCookies(
    respond({
      ok: true,
      userId,
      email: grant.user?.email ?? null,
      role: profile?.role ?? "sales",
      isActive: true,
      forcePasswordChange: profile?.force_password_change ?? false,
      fullName: profile?.full_name ?? null,
    }),
    {
      accessToken,
      refreshToken,
      expiresIn: normalizeExpiresIn(grant.expires_in),
    },
  );
}
