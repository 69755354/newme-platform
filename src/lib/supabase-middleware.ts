import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Creates a Supabase SSR client for use in Next.js 16 middleware (proxy.ts).
 *
 * In Next.js 16, the middleware convention has been renamed from `middleware.ts`
 * to `proxy.ts`. This helper handles cookie forwarding so that the Supabase
 * session (access/refresh tokens) is available in the middleware and the
 * response's `Set-Cookie` headers are properly forwarded to the client.
 */
export function createMiddlewareClient(request: NextRequest) {
  // Create a mutable response so we can attach Set-Cookie headers
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
          headers: Record<string, string>,
        ) {
          // Keep the refreshed cookies in the request passed downstream. Without
          // this, a later server component sees the stale request cookie and can
          // race the refresh that just completed in this proxy invocation.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          // Apply anti-caching headers when auth cookies are set
          Object.entries(headers).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        },
      },
    },
  );

  return { supabase, response };
}
