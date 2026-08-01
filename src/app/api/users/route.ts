// RBAC: active organization admin/boss membership.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { finalizeTriggerCreatedUserProfile } from "@/lib/user-profile-provisioning";
import {
  activeOrganizationMemberIds,
  OrganizationMemberAdminError,
  resolveOrganizationMemberAdminAccess,
} from "@/lib/organization-member-admin";
import { RequestAuthError } from "@/lib/request-auth-context";

const VALID_ROLES = [
  "admin",
  "boss",
  "sales",
  "designer",
  "operator",
  "finance",
];

function accessError(error: unknown): NextResponse | null {
  if (
    error instanceof OrganizationMemberAdminError
    || error instanceof RequestAuthError
  ) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationMemberAdminAccess(request);
    const memberIds = await activeOrganizationMemberIds(access.organizationId);
    if (memberIds.length === 0) {
      return NextResponse.json({
        organization_id: access.organizationId,
        users: [],
      });
    }

    const { data: profiles, error } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name, role, is_active, last_active_at, force_password_change")
      .in("id", memberIds)
      .order("full_name", { ascending: true });
    if (error) {
      return NextResponse.json(
        { error: "organization_members_fetch_failed" },
        { status: 503 },
      );
    }

    const authEntries = await Promise.all(
      memberIds.map(async (userId) => {
        const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
        return [userId, data.user] as const;
      }),
    );
    const authMap = new Map(authEntries);
    const users = (profiles ?? []).map((profile) => {
      const authUser = authMap.get(profile.id);
      return {
        ...profile,
        last_active_at:
          authUser?.last_sign_in_at || profile.last_active_at || null,
        created_at: authUser?.created_at || null,
      };
    });
    return NextResponse.json({
      organization_id: access.organizationId,
      users,
    });
  } catch (error) {
    return accessError(error) ?? NextResponse.json(
      { error: "organization_members_fetch_failed" },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  let createdUserId: string | null = null;
  try {
    const access = await resolveOrganizationMemberAdminAccess(request);
    const body = await request.json();
    const { email, password, full_name, role, phone } = body;
    if (!email || !password || !full_name || !role) {
      return NextResponse.json(
        { error: "Missing required fields: email, password, full_name, role" },
        { status: 400 },
      );
    }
    if (!VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, role, phone },
      });
    if (authError || !authData.user) {
      return NextResponse.json(
        { error: authError?.message || "user_creation_failed" },
        { status: 400 },
      );
    }
    createdUserId = authData.user.id;

    const profileResult = await finalizeTriggerCreatedUserProfile(createdUserId, {
      email,
      fullName: full_name,
      role,
      phone,
    });
    if (!profileResult.ok) {
      throw new Error("profile_creation_failed");
    }

    const { error: membershipError } = await supabaseAdmin.rpc(
      "provision_organization_member",
      {
        p_organization_id: access.organizationId,
        p_user_id: createdUserId,
        p_profile_role: role,
        p_invited_by_membership_id: access.callerMembershipId,
        p_request_id: access.context.requestId,
      },
    );
    if (membershipError) {
      const safeReason = [
        "billable_seat_limit_reached",
        "organization_membership_already_exists",
      ].find((reason) => membershipError.message.includes(reason));
      throw new Error(safeReason ?? "organization_member_provision_failed");
    }

    return NextResponse.json(
      {
        organization_id: access.organizationId,
        user: {
          id: createdUserId,
          email,
          full_name,
          role,
          phone: phone || null,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (createdUserId) {
      await supabaseAdmin.auth.admin.deleteUser(createdUserId);
    }
    return accessError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid_request" },
      { status: 400 },
    );
  }
}
