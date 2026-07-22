import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export interface RefreshedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

type ServerSupabaseClient = ReturnType<typeof createClient> & {
  __refreshedCookies?: RefreshedCookie[];
  __refreshAttempted?: boolean;
};

/**
 * Parse the @supabase/ssr-format auth token cookie.
 * Returns the session object or null.
 */
type SsrCookie = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
};

function parseSsrCookieValue(value: string): SsrCookie | null {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null ? (parsed as SsrCookie) : null;
}

function parseSsrCookie(value: string): SsrCookie | null {
  try {
    // The login page stores it as a plain JSON string (not base64)
    return parseSsrCookieValue(value);
  } catch {
    try {
      return parseSsrCookieValue(atob(value));
    } catch {
      return null;
    }
  }
}

/**
 * Parse a raw Cookie header string into name-value pairs.
 */
export function parseCookieHeader(cookieHeader: string): Array<{ name: string; value: string }> {
  return cookieHeader
    .split(";")
    .map((c) => {
      const idx = c.indexOf("=");
      if (idx === -1) return { name: c.trim(), value: "" };
      return { name: c.substring(0, idx).trim(), value: c.substring(idx + 1).trim() };
    })
    .filter((c) => c.name.length > 0);
}

/**
 * Extract access_token and refresh_token from cookies.
 */
function extractTokens(
  allCookies: Array<{ name: string; value: string }>,
): { accessToken?: string; refreshToken?: string } {
  let a: string | undefined;
  let r: string | undefined;
  const c = allCookies.find((x) => x.name === "sb-vfopmpxlhwzpxqegayew-auth-token");
  if (c) {
    const s = parseSsrCookie(c.value);
    if (s?.access_token) {
      a = s.access_token;
      if (s.expires_at && s.expires_at * 1000 < Date.now()) {
        const x = allCookies.find((y) => y.name === "sb-vfopmpxlhwzpxqegayew-refresh-token");
        r = x?.value || s.refresh_token;
        a = undefined;
      }
    }
  }
  if (!a && !r) {
    const lt = allCookies.find((x) => x.name === "sb-access-token");
    if (lt) a = lt.value;
    const lr = allCookies.find((x) => x.name === "sb-refresh-token");
    if (lr) r = lr.value;
  }
  return { accessToken: a, refreshToken: r };
}

/**
 * Attempt to refresh the access token using the refresh_token cookie.
 * Returns { accessToken, refreshToken, expiresAt } or null.
 */
async function tryRefreshToken(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    };
  } catch {
    return null;
  }
}

/**
 * Module-level lock for token refresh. Supabase invalidates a refresh_token
 * after each use, so if several concurrent SSR requests share an expired token
 * they MUST share a single in-flight refresh — otherwise only the first caller
 * succeeds and the rest hit a revoked-token error. Keyed by refreshToken so
 * distinct sessions don't collide, and cleared once the refresh settles.
 */
const refreshInFlight = new Map<
  string,
  Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null>
>();

function tryRefreshTokenLocked(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  const existing = refreshInFlight.get(refreshToken);
  if (existing) return existing;
  const promise = tryRefreshToken(supabaseUrl, anonKey, refreshToken).finally(() => {
    refreshInFlight.delete(refreshToken);
  });
  refreshInFlight.set(refreshToken, promise);
  return promise;
}

export async function createServerSupabase(
  bearerToken?: string,
  cookieString?: string,
) {
  let refreshedCookies: RefreshedCookie[] = [];
  let refreshAttempted = false;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // ── 1. Obtain cookies ──
  const _cookieStore = cookieString === undefined ? await cookies() : null;
  const allCookies = cookieString !== undefined
    ? parseCookieHeader(cookieString)
    : _cookieStore!.getAll();

  // ── 2. Extract tokens ──
  const { accessToken: initialAccessToken, refreshToken } = extractTokens(allCookies);
  let accessToken = initialAccessToken;

  // ── 2. If token is expired, try to refresh ──
  if (!accessToken && refreshToken) {
    refreshAttempted = true;
    const refreshed = await tryRefreshTokenLocked(supabaseUrl, anonKey, refreshToken);
    if (refreshed) {
      accessToken = refreshed.accessToken;
      // Update the auth token cookie so subsequent requests don't need to refresh again
      const newPayload = JSON.stringify({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        expires_at: refreshed.expiresAt,
      });
      // Only set cookies when using the legacy cookies() API (not explicit header)
      refreshedCookies = [
        { name: "sb-vfopmpxlhwzpxqegayew-auth-token", value: newPayload, options: { path: "/", maxAge: refreshed.expiresAt - Math.floor(Date.now() / 1000), sameSite: "strict", secure: true, httpOnly: false } },
        { name: "sb-vfopmpxlhwzpxqegayew-refresh-token", value: refreshed.refreshToken, options: { path: "/", maxAge: 2592000, sameSite: "strict", secure: true, httpOnly: false } },
      ];
      if (_cookieStore) {
        _cookieStore.set("sb-vfopmpxlhwzpxqegayew-auth-token", newPayload, {
        path: "/",
        maxAge: refreshed.expiresAt - Math.floor(Date.now() / 1000),
        sameSite: "strict",
        secure: true,
        httpOnly: false,
      });
      _cookieStore.set("sb-vfopmpxlhwzpxqegayew-refresh-token", refreshed.refreshToken, {
        path: "/",
        maxAge: 2592000,
        sameSite: "strict",
        secure: true,
        httpOnly: false,
      });
      }
    }
  }

  // ── 3. Create client with or without auth ──
  // bearerToken (from Authorization header) takes highest priority — a stale
  // cookie session must never pollute the global Authorization used by
  // subsequent .from() queries, or RLS policies (auth.uid() = id) reject them.
  const headers: Record<string, string> = {
    apikey: anonKey,
  };
  const effectiveToken = bearerToken ?? accessToken;
  if (effectiveToken) {
    headers.Authorization = `Bearer ${effectiveToken}`;
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers },
  }) as ServerSupabaseClient;
  client.__refreshedCookies = refreshedCookies;
  client.__refreshAttempted = refreshAttempted;
  return client;
}

/**
 * Get cookies that were refreshed during createServerSupabase.
 * Returns empty array if no refresh occurred.
 */
export function getRefreshedCookies(client: unknown): RefreshedCookie[] {
  return (client as ServerSupabaseClient).__refreshedCookies || [];
}

/**
 * Whether a token refresh was attempted during createServerSupabase.
 */
export function getRefreshAttempted(client: unknown): boolean {
  return (client as ServerSupabaseClient).__refreshAttempted === true;
}