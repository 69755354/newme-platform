import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// POST /api/auth/change-password
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { oldPassword, newPassword } = await request.json();

    if (!oldPassword || !newPassword) {
      return NextResponse.json({ error: "oldPassword and newPassword required" }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    // Get user email
    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", user.id)
      .single();

    if (!profile?.email) {
      return NextResponse.json({ error: "Profile not found" }, { status: 400 });
    }

    // Verify old password
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: profile.email,
      password: oldPassword,
    });

    if (signInErr) {
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
    }

    // Update password via admin API
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    );

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Update profile: clear force_password_change, update password_changed_at timestamp
    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({
        force_password_change: false,
        password_changed_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (profileErr) {
      return NextResponse.json(
        { error: "Password changed but session invalidation failed. Please contact admin." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
