// RBAC: user (authenticated)
import { createServerSupabase } from "@/lib/supabase-server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";
import { NextResponse } from "next/server";

const LEGACY_COOKIE_NAMES = ["sb-access-token", "sb-refresh-token"];

export async function POST(request: Request) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    await supabase.auth.signOut();

    const names = getSupabaseCookieNames();
    const response = NextResponse.json({ ok: true });
    for (const name of [names.authToken, names.refreshToken, ...LEGACY_COOKIE_NAMES]) {
      response.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
    return response;
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
