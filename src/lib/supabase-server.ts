import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for Server Components and Route Handlers.
 *
 * Uses @supabase/ssr createServerClient for correct chunked-cookie parsing
 * and session handling. Token refresh is performed by the proxy (src/proxy.ts)
 * via createMiddlewareClient on every matched request.
 *
 * Previously this hand-rolled `atob` decoding of a single cookie, which failed
 * when @supabase/ssr chunked the session across multiple cookies (sb-*-auth-token.0/.1/…),
 * causing intermittent "session lost" / 401 errors.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll called from a non-mutable context (Server Component).
            // Safe to ignore — the proxy refreshes sessions on the next request.
          }
        },
      },
    },
  );
}

/**
 * Get authenticated user from request. Tries:
 * 1. Cookie-based auth (normal flow)
 * 2. Bearer token header (API testing with service_role or user JWT)
 */
export async function getAuthUser(request: Request) {
  // Try cookie auth first
  const supabase = await createServerSupabase();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (!error && user) return { user, supabase };

  // Fallback: Bearer token (for automated testing)
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const { data: { user: tokenUser }, error: tokenErr } = await supabase.auth.getUser(token);
    if (!tokenErr && tokenUser) return { user: tokenUser, supabase };
  }

  return { user: null, supabase, error };
}
