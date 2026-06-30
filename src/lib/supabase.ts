import { createClient as _createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let _client: SupabaseClient | null = null;

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
  // Always try to refresh the session token — the client is a singleton
  // but the session may change after login
  const session = getAuthSession();

  if (_client) {
    if (session) {
      _client.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    }
    return _client;
  }

  _client = _createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
      storage: undefined as any,
    },
  });

  if (session) {
    _client.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  }

  return _client;
}
