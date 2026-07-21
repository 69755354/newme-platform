// RBAC: user (authenticated)
import { createServerSupabase } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

/**
 * POST /api/auth/logout — sign out and clear auth cookies.
 */
export async function POST(request: Request) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    await supabase.auth.signOut();

    const response = NextResponse.json({ ok: true });
    // Clear auth cookies
    response.cookies.set("sb-vfopmpxlhwzpxqegayew-auth-token", "", { path: "/", maxAge: 0 });
    response.cookies.set("sb-vfopmpxlhwzpxqegayew-refresh-token", "", { path: "/", maxAge: 0 });
    response.cookies.set("sb-access-token", "", { path: "/", maxAge: 0 });
    response.cookies.set("sb-refresh-token", "", { path: "/", maxAge: 0 });

    return response;
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
