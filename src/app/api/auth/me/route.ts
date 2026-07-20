// RBAC: user (authenticated)
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

/**
 * GET /api/auth/me — returns current user info from session cookie.
 * Used by dashboard layout to avoid client-side Supabase dependency.
 *
 * Profile lookup uses a service_role admin client to bypass RLS and any
 * cookie/header pollution from the request context. Prior hotfixes tried
 * routing through anon-key REST + the user's bearer; both failed in
 * production (stale cookie RLS rejection and blocked egress respectively).
 */
export async function GET(request: Request) {
  try {
    const bearerToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const supabase = await createServerSupabase(bearerToken);
    const {
      data: { user },
    } = bearerToken
      ? await supabase.auth.getUser(bearerToken)
      : await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: profile } = await adminClient
      .from("profiles")
      .select("role, is_active, force_password_change, full_name, email")
      .eq("id", user.id)
      .single();

    if (!profile || profile.is_active !== true) {
      return NextResponse.json({
        error: "inactive_account",
        _dbg_key: serviceRoleKey ? serviceRoleKey.substring(0, 8) + "..." : "MISSING",
      }, { status: 401 });
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
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
