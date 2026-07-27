// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// ─── Auth check ───
async function checkRole(request: NextRequest): Promise<NextResponse | string> {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch role from profiles
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileErr || !profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 403 });
  }

  if (profile.role !== "admin" && profile.role !== "boss") {
    return NextResponse.json(
      { error: "Insufficient permissions. Admin or Boss role required." },
      { status: 403 },
    );
  }

  return profile.role; // allowed — role for downstream enforcement
}

// ─── GET /api/users — list all users ───
export async function GET(request: NextRequest) {
  const role = await checkRole(request);
  if (role instanceof NextResponse) return role;

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, role, is_active, last_active_at, force_password_change")
    .order("full_name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }

  // Enrich with auth-level last_sign_in_at (Supabase auto-updates this)
  let authMap: Record<string, { last_sign_in_at: string | null; created_at: string }> = {};
  try {
    const { data: authData } = await supabaseAdmin.auth.admin.listUsers();
    if (authData?.users) {
      for (const u of authData.users) {
        authMap[u.id] = {
          last_sign_in_at: u.last_sign_in_at ?? null,
          created_at: u.created_at,
        };
      }
    }
  } catch (e) {
    console.error("[users] Failed to fetch auth users:", e);
  }

  // Merge: prefer auth last_sign_in_at over profiles last_active_at
  const users = (data || []).map((p: any) => {
    const auth = authMap[p.id];
    return {
      ...p,
      last_active_at: auth?.last_sign_in_at || p.last_active_at || null,
      created_at: auth?.created_at || null,
    };
  });

  return NextResponse.json({ users });
}

// ─── POST /api/users — create new user ───
export async function POST(request: NextRequest) {
  const callerRole = await checkRole(request);
  if (callerRole instanceof NextResponse) return callerRole;

  try {
    const body = await request.json();
    const { email, password, full_name, role, phone } = body;

    // Validate required fields
    if (!email || !password || !full_name || !role) {
      return NextResponse.json(
        { error: "Missing required fields: email, password, full_name, role" },
        { status: 400 },
      );
    }

    const validRoles = [
      "admin",
      "boss",
      "sales",
      "designer",
      "operator",
      "finance",
    ];
    if (!validRoles.includes(role)) {
      return NextResponse.json(
        {
          error: `Invalid role. Must be one of: ${validRoles.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // 1. Create auth user via admin API
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, role, phone },
      });

    if (authError) {
      console.error("[users] createUser auth error:", authError);
      return NextResponse.json(
        { error: authError.message || "Failed to create auth user" },
        { status: 400 }
      );
    }

    if (!authData.user) {
      return NextResponse.json(
        { error: "Failed to create user" },
        { status: 500 },
      );
    }

    // 2. Update the profile created by the auth.users trigger
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({
        email,
        full_name,
        role,
        phone: phone || null,
        is_active: true,
        force_password_change: true, // Force password change on first login
      })
      .eq("id", authData.user.id);

    if (profileError) {
      // Attempt cleanup: delete the auth user if profile update fails
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return NextResponse.json(
        { error: "Failed to create profile" },
        { status: 500 },
      );
    }

    // Notify admins about new team member
    try {
      const { getAdminUserIds, createNotificationsBulk } = await import("@/lib/notifications");
      const adminIds = await getAdminUserIds();
      if (adminIds.length > 0) {
        await createNotificationsBulk(
          adminIds.map((id) => ({
            userId: id,
            type: "team_member_added",
            title: `New team member: ${full_name}`,
            body: `${full_name} added as ${role}`,
            relatedId: authData.user.id,
            relatedType: "user",
          }))
        );
      }
    } catch (notifyErr) {
      console.error("[users] team_member_added notification failed:", notifyErr);
    }

    return NextResponse.json(
      {
        user: {
          id: authData.user.id,
          email,
          full_name,
          role,
          phone: phone || null,
        },
      },
      { status: 201 },
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}
