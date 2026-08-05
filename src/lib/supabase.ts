import { createClient as _createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { parseAuthSessionCookie } from "@/lib/auth-cookie.mjs";

interface AuthSession {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

let _client: SupabaseClient<Database> | null = null;
let _sessionToken: string | null = null;

function getAuthSession(): AuthSession | null {
  if (typeof document === "undefined") return null;
  const names = getSupabaseCookieNames();
  return parseAuthSessionCookie(document.cookie, names.authToken);
}

export function createClient(): SupabaseClient<Database> {
  const session = getAuthSession();
  const nextToken = session?.access_token ?? null;
  const tokenChanged = nextToken !== _sessionToken;

  if (_client && !tokenChanged) {
    return _client;
  }

  if (!_client || tokenChanged) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      if (typeof window === "undefined") {
        return new Proxy({} as SupabaseClient<Database>, {
          get(_target, property) {
            if (property === "auth") {
              return { getSession: () => Promise.resolve({ data: { session: null }, error: null }) };
            }
            if (property === "from") {
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

    _client = _createSupabaseClient<Database>(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: nextToken
        ? { headers: { Authorization: `Bearer ${nextToken}` } }
        : undefined,
    });
    _sessionToken = nextToken;
  }

  return _client;
}

/**
 * Client requests use the access token from the readable auth cookie.
 * Refresh tokens remain HttpOnly; refresh is performed by the server boundary.
 */
export async function ensureSession(): Promise<void> {
  return Promise.resolve();
}
