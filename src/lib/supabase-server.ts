import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function createServerSupabase() {
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();

  // Try to find auth token from cookies (supports multiple formats)
  let accessToken: string | undefined;

  // 1. @supabase/ssr format: sb-{ref}-auth-token = base64(session_json)
  const ssrCookie = allCookies.find(c => c.name === "sb-vfopmpxlhwzpxqegayew-auth-token");
  if (ssrCookie) {
    try {
      const decoded = atob(ssrCookie.value);
      const session = JSON.parse(decoded);
      accessToken = session.access_token;
    } catch {}
  }

  // 2. Legacy format: sb-access-token = raw access_token
  if (!accessToken) {
    const legacyCookie = allCookies.find(c => c.name === "sb-access-token");
    if (legacyCookie) {
      accessToken = legacyCookie.value;
    }
  }

  // Create client with or without auth
  const headers: Record<string, string> = {
    apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers },
    },
  );
}
