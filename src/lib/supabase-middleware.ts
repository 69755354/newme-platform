import { type NextRequest, NextResponse } from "next/server";
import { createServerSupabase, getRefreshedCookies } from "@/lib/supabase-server";

/**
 * Creates a Supabase SSR client for use in Next.js 16 middleware (proxy.ts).
 *
 * In Next.js 16, the middleware convention has been renamed from `middleware.ts`
 * to `proxy.ts`. This helper handles cookie forwarding so that the Supabase
 * session (access/refresh tokens) is available in the middleware and the
 * response's `Set-Cookie` headers are properly forwarded to the client.
 */
export async function createMiddlewareClient(request: NextRequest) {
  const supabase = await createServerSupabase(undefined, request.headers.get("cookie") ?? "");
  const refreshedCookies = getRefreshedCookies(supabase);

  // Keep custom split-session refreshes in the request passed downstream and
  // in the browser response so the same request cannot refresh the old token.
  refreshedCookies.forEach(({ name, value }) => request.cookies.set(name, value));
  const response = NextResponse.next({ request });
  refreshedCookies.forEach(({ name, value, options }) =>
    response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2]),
  );

  return { supabase, getResponse: () => response };
}
