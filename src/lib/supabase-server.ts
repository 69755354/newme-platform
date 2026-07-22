import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { cookies } from "next/headers";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { classifyRefreshFailure } from "@/lib/auth-refresh.mjs";

export interface RefreshedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

type RefreshFailure = "missing_refresh_token" | "invalid_refresh_token" | "upstream_error";
type RefreshSession = { accessToken: string; refreshToken: string; expiresAt: number };
type RefreshResult = { session: RefreshSession | null; failure?: Exclude<RefreshFailure, "missing_refresh_token"> };

type ServerSupabaseClient = SupabaseClient<Database> & {
  __refreshedCookies?: RefreshedCookie[];
  __refreshAttempted?: boolean;
  __refreshFailure?: RefreshFailure;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
  names: ReturnType<typeof getSupabaseCookieNames>,
): { accessToken?: string; refreshToken?: string } {
  let a: string | undefined;
  let r: string | undefined;
  const c = allCookies.find((x) => x.name === names.authToken);
  if (c) {
    const s = parseSsrCookie(c.value);
    if (s?.access_token) {
      a = s.access_token;
      if (s.expires_at && s.expires_at * 1000 < Date.now()) {
        const x = allCookies.find((y) => y.name === names.refreshToken);
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
): Promise<RefreshResult> {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      return { session: null, failure: "upstream_error" };
    }
    if (!res.ok) {
      return { session: null, failure: classifyRefreshFailure(res.status, data) };
    }
    if (
      !isRecord(data) ||
      typeof data.access_token !== "string" ||
      typeof data.refresh_token !== "string" ||
      typeof data.expires_in !== "number"
    ) {
      return { session: null, failure: "upstream_error" };
    }
    return {
      session: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      },
    };
  } catch {
    return { session: null, failure: "upstream_error" };
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
  Promise<RefreshResult>
>();

function tryRefreshTokenLocked(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string,
): Promise<RefreshResult> {
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
  let refreshFailure: RefreshFailure | undefined;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const names = getSupabaseCookieNames(supabaseUrl);

  // ── 1. Obtain cookies ──
  const _cookieStore = cookieString === undefined ? await cookies() : null;
  const allCookies = cookieString !== undefined
    ? parseCookieHeader(cookieString)
    : _cookieStore!.getAll();

  // ── 2. Extract tokens ──
  const { accessToken: initialAccessToken, refreshToken } = extractTokens(allCookies, names);
  let accessToken = initialAccessToken;
  const hasAuthCookie = allCookies.some((cookie) => cookie.name === names.authToken || cookie.name === "sb-access-token");

  // ── 2. If token is expired, try to refresh ──
  if (!accessToken && refreshToken) {
    refreshAttempted = true;
    const refreshResult = await tryRefreshTokenLocked(supabaseUrl, anonKey, refreshToken);
    refreshFailure = refreshResult.failure;
    const refreshed = refreshResult.session;
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
        { name: names.authToken, value: newPayload, options: { path: "/", maxAge: refreshed.expiresAt - Math.floor(Date.now() / 1000), sameSite: "strict", secure: true, httpOnly: false } },
        { name: names.refreshToken, value: refreshed.refreshToken, options: { path: "/", maxAge: 2592000, sameSite: "strict", secure: true, httpOnly: true } },
      ];
      if (_cookieStore) {
        _cookieStore.set(names.authToken, newPayload, {
        path: "/",
        maxAge: refreshed.expiresAt - Math.floor(Date.now() / 1000),
        sameSite: "strict",
        secure: true,
        httpOnly: false,
      });
      _cookieStore.set(names.refreshToken, refreshed.refreshToken, {
        path: "/",
        maxAge: 2592000,
        sameSite: "strict",
        secure: true,
        httpOnly: true,
      });
      }
    }
  } else if (!accessToken && hasAuthCookie) {
    refreshFailure = "missing_refresh_token";
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

  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers },
  }) as ServerSupabaseClient;
  client.__refreshedCookies = refreshedCookies;
  client.__refreshAttempted = refreshAttempted;
  client.__refreshFailure = refreshFailure;
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
/**
 * Whether refresh failed because the session is invalid, missing, or upstream-unavailable.
 */
export function getRefreshFailure(client: unknown): RefreshFailure | undefined {
  return (client as ServerSupabaseClient).__refreshFailure;
}
