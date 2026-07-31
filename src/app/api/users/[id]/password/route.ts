// RBAC: user (admin, boss)
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  OrganizationMemberAdminError,
  requireOrganizationMembership,
  resolveOrganizationMemberAdminAccess,
} from "@/lib/organization-member-admin";
import { RequestAuthError } from "@/lib/request-auth-context";

// GET /api/users/[id]/password — Admin/boss view password hint
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const access = await resolveOrganizationMemberAdminAccess(request);
    await requireOrganizationMembership(access.organizationId, targetId);

    const { data: target, error } = await supabaseAdmin
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
    const { password } = await request.json();

    if (!password || password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    if (targetId === "change-password") {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password });
      if (error) return NextResponse.json({ error: error.message || "Update failed" }, { status: 400 });

      const { error: profileErr } = await supabaseAdmin
        .from("profiles")
        .update({ password_changed_at: new Date().toISOString() })
        .eq("id", user.id);

      if (profileErr) {
        return NextResponse.json(
          { error: "Password changed but audit timestamp could not be recorded. Please contact admin." },
          { status: 500 }
        );
      }
      return NextResponse.json({ success: true });
    }

    const access = await resolveOrganizationMemberAdminAccess(request);
    await requireOrganizationMembership(access.organizationId, targetId);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(targetId, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({ password_changed_at: new Date().toISOString() })
      .eq("id", targetId);

    if (profileErr) {
      return NextResponse.json(
        { error: "Password changed but audit timestamp could not be recorded. Please contact admin." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    if (
      e instanceof OrganizationMemberAdminError
      || e instanceof RequestAuthError
    ) {
      return NextResponse.json({ error: e.code }, { status: e.status });
    }
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
