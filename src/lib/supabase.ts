import { createBrowserClient } from "@supabase/ssr";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Browser-side Supabase client.
 *
 * Uses @supabase/ssr createBrowserClient for automatic session management,
 * token refresh, and chunked-cookie support. This replaces the previous
 * hand-rolled cookie/localStorage parsing (autoRefreshToken:false + manual
 * setSession) which dropped sessions when the auth cookie was chunked.
 *
 * Signature-compatible with the old createClient() — drop-in for all callers.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
