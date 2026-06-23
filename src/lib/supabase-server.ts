import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * Parse the @supabase/ssr-format auth token cookie.
 * Returns the session object or null.
 */
function parseSsrCookie(value: string): Record<string, any> | null {
  try {
    // The login page stores it as a plain JSON string (not base64)
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(atob(value));
    } catch {
      return null;
    }
  }
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

export async function createServerSupabase() {
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // ── 1. Extract access_token + refresh_token from cookies ──
  let accessToken: string | undefined;
  let refreshToken: string | undefined;

  // Format A: @supabase/ssr plain JSON cookie
  const ssrCookie = allCookies.find(c => c.name === "sb-vfopmpxlhwzpxqegayew-auth-token");
  if (ssrCookie) {
    const session = parseSsrCookie(ssrCookie.value);
    if (session?.access_token) {
      accessToken = session.access_token;
      // Check if expired — if so, try refresh
      if (session.expires_at && session.expires_at * 1000 < Date.now()) {
        const refreshCookie = allCookies.find(c => c.name === "sb-vfopmpxlhwzpxqegayew-refresh-token");
        refreshToken = refreshCookie?.value || session.refresh_token;
        accessToken = undefined; // will try refresh below
      }
    }
  }

  // Format B: legacy raw tokens
  if (!accessToken && !refreshToken) {
    const legacyToken = allCookies.find(c => c.name === "sb-access-token");
    if (legacyToken) accessToken = legacyToken.value;
    const legacyRefresh = allCookies.find(c => c.name === "sb-refresh-token");
    if (legacyRefresh) refreshToken = legacyRefresh.value;
  }

  // ── 2. If token is expired, try to refresh ──
  if (!accessToken && refreshToken) {
    const refreshed = await tryRefreshToken(supabaseUrl, anonKey, refreshToken);
    if (refreshed) {
      accessToken = refreshed.accessToken;
      // Update the auth token cookie so subsequent requests don't need to refresh again
      const newPayload = JSON.stringify({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        expires_at: refreshed.expiresAt,
      });
      cookieStore.set("sb-vfopmpxlhwzpxqegayew-auth-token", newPayload, {
        path: "/",
        maxAge: refreshed.expiresAt - Math.floor(Date.now() / 1000),
        sameSite: "strict",
        secure: true,
        httpOnly: false,
      });
      cookieStore.set("sb-vfopmpxlhwzpxqegayew-refresh-token", refreshed.refreshToken, {
        path: "/",
        maxAge: 2592000,
        sameSite: "strict",
        secure: true,
        httpOnly: false,
      });
    }
  }

  // ── 3. Create client with or without auth ──
  const headers: Record<string, string> = {
    apikey: anonKey,
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers },
  });
}
