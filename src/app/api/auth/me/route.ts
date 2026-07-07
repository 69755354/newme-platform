import { createServerSupabase } from "@/models/supabase-server";
import { NextResponse } from "next/server";

/**
 * GET /api/auth/me — returns current user info from session cookie.
 * Used by dashboard layout to avoid client-side Supabase dependency.
 */
export async function GET() {
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("role, force_password_change, full_name, email")
      .eq("id", user.id)
      .single();

    const role = profile?.role ?? "sales";

    return NextResponse.json({
      userId: user.id,
      email: user.email ?? null,
      role,
      forcePasswordChange: profile?.force_password_change ?? false,
      fullName: profile?.full_name ?? null,
    });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
