// RBAC: user (authenticated)
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

/**
 * GET /api/auth/me — returns current user info from session cookie.
 * Used by dashboard layout to avoid client-side Supabase dependency.
 *
 * Cookies are extracted from the Request object explicitly and passed to
 * createServerSupabase via cookieString, avoiding the implicit next/headers
 * cookies() API. This ensures the route works regardless of how node_modules
 * is resolved (source repo, frozen copy, or any other path).
 */
export async function GET(request: Request) {
  try {
    const bearerToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);

    const {
      data: { user },
      error: authError,
    } = bearerToken
      ? await supabase.auth.getUser(bearerToken)
      : await supabase.auth.getUser();

    // Invalid or missing session → 401
    if (!user || authError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[auth/me] missing environment: SUPABASE_URL or SERVICE_ROLE_KEY");
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role, is_active, force_password_change, full_name, email")
      .eq("id", user.id)
      .single();

    if (profileError) {
      console.error("[auth/me] profile lookup failed", { code: profileError.code });
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    if (!profile || profile.is_active !== true) {
      return NextResponse.json({ error: "inactive_account" }, { status: 401 });
    }

    const role = profile.role ?? "sales";

    return NextResponse.json({
      userId: user.id,
      email: user.email ?? null,
      role,
      isActive: profile?.is_active === true,
      forcePasswordChange: profile.force_password_change ?? false,
      fullName: profile.full_name ?? null,
    });
  } catch (err) {
    console.error("[auth/me] unhandled error", {
      name: (err as Error).name,
      message: (err as Error).message?.slice(0, 200),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
