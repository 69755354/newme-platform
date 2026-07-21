import { createClient as _createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;
let _sessionToken: string | null = null;
let _initPromise: Promise<void> | null = null;

interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}

function getAuthSession(): AuthSession | null {
  if (typeof window !== "undefined") {
    // Try localStorage first (ssr format — full JSON session)
    try {
      const raw = localStorage.getItem("sb-vfopmpxlhwzpxqegayew-auth-token");
      if (raw) {
        const session = JSON.parse(raw);
        if (session.access_token && session.refresh_token) {
          return { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at };
        }
      }
    } catch {}
  }
  if (typeof document !== "undefined") {
    // Try @supabase/ssr cookie format (base64-encoded JSON session)
    const ssrCookie = document.cookie.match(/sb-vfopmpxlhwzpxqegayew-auth-token=([^;]+)/);
    if (ssrCookie) {
      try {
        const decoded = atob(ssrCookie[1]);
        const session = JSON.parse(decoded);
        if (session.access_token && session.refresh_token) {
          return { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at };
        }
      } catch {}
    }
    // Fallback: legacy raw access_token + refresh_token cookies
    const legacyAccess = document.cookie.match(/sb-access-token=([^;]+)/);
    const legacyRefresh = document.cookie.match(/sb-refresh-token=([^;]+)/);
    if (legacyAccess && legacyAccess[1]) {
      return { access_token: legacyAccess[1], refresh_token: legacyRefresh?.[1] ?? "" };
    }
  }
  return null;
}

export function createClient(): SupabaseClient {
  const session = getAuthSession();
  const tokenChanged = session && session.access_token !== _sessionToken;

  if (_client && !tokenChanged) {
    return _client;
  }

  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      // SSR / isolated build guard: return a stub that defers all operations.
      // The real client will be created client-side where NEXT_PUBLIC_* vars exist.
      if (typeof window === "undefined") {
        return new Proxy({} as SupabaseClient, {
          get(_t, prop) {
            if (prop === "auth") {
              return { getSession: () => Promise.resolve({ data: { session: null }, error: null }) };
            }
            if (prop === "from") {
              return () => ({
                select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
                insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
              });
            }
            return () => Promise.resolve({ data: null, error: null });
          },
        });
      }
      throw new Error("supabase client: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY required");
    }
    _client = _createSupabaseClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        storage: undefined as any,
      },
    });
  }

  if (session && tokenChanged) {
    _sessionToken = session.access_token;
    _initPromise = (async () => {
      await _client!.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    })();
  }

  return _client;
}

/**
 * Must be called before using the client if you need authenticated requests.
 * Waits for setSession to complete so getUser() uses the fresh token.
 */
export async function ensureSession(): Promise<void> {
  if (_initPromise) {
    await _initPromise;
    _initPromise = null;
  }
}
