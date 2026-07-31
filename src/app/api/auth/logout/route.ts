// RBAC: user (authenticated)
import { extractSessionTokensFromCookieHeader } from "@/lib/supabase-server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { NextResponse } from "next/server";

const LEGACY_COOKIE_NAMES = ["sb-access-token", "sb-refresh-token"];

async function refreshAccessToken(refreshToken: string): Promise<string | undefined> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return undefined;

  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return undefined;

  const data: unknown = await response.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("access_token" in data) ||
    typeof data.access_token !== "string"
  ) {
    return undefined;
  }
  return data.access_token;
}

async function revokeCurrentSession(accessToken: string): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return false;

  const response = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return response.ok;
}

export async function POST(request: Request) {
  const bearerToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const cookieHeader = request.headers.get("cookie") ?? "";
  const tokens = extractSessionTokensFromCookieHeader(cookieHeader);
  let revoked = false;

  try {
    const accessToken =
      bearerToken ??
      tokens.accessToken ??
      (tokens.refreshToken ? await refreshAccessToken(tokens.refreshToken) : undefined);
    if (accessToken) {
      revoked = await revokeCurrentSession(accessToken);
    }
  } catch {
    // Always clear the browser session even when Auth is temporarily unavailable.
  }

  const names = getSupabaseCookieNames();
  const response = NextResponse.json({ ok: true, revoked });
  for (const name of [names.authToken, names.refreshToken, ...LEGACY_COOKIE_NAMES]) {
    response.cookies.set(name, "", { path: "/", maxAge: 0 });
  }
  return response;
}
