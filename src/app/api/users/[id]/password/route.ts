import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";

// GET /api/users/[id]/password — Admin/boss view password hint
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: profile } = await adminClient
      .from("profiles").select("role").eq("id", user.id).single();

    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Fetch target user's full_name (no longer store plaintext passwords)
    const { data: target, error } = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("id", targetId)
      .single();

    if (error || !target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ hint: "Password was reset. User should check email or contact admin.", full_name: target.full_name });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

// PATCH /api/users/[id]/password — Reset password
// For [id]="change-password" — user changes own password
// For [id]=user-uuid — admin/boss resets target user's password
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const body = await request.json();
    const { password } = body;

    if (!password || password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Self-change
    if (targetId === "change-password") {
      try {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          return NextResponse.json({ error: error.message || "Update failed" }, { status: 400 });
        }
        // Note: passwords are no longer stored in profiles
        return NextResponse.json({ success: true });
      } catch {
        return NextResponse.json({ error: "Session invalid" }, { status: 401 });
      }
    }

    // Admin/boss reset: verify current user role
    const { data: profile } = await adminClient
      .from("profiles").select("role").eq("id", user.id).single();

    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Reset target user's password
    const { error } = await adminClient.auth.admin.updateUserById(targetId, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Note: passwords are no longer stored in profiles
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
