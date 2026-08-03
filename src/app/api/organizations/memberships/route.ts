// RBAC: organization.members.manage for invitations; invited user for acceptance.
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { getRequestedOrganizationId } from "@/lib/organization-context";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";

type Body = Record<string, unknown>;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as Body | null;
    if (!body) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const action = body.action;
    if (action === "invite") {
      const access = await resolveOrganizationAuthorization(
        request,
        "organization.members.manage",
        "write",
      );
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      const roleKey = typeof body.role_key === "string" ? body.role_key : "";
      if (!userId || !roleKey) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      }
      const { data, error } = await access.context.supabase.rpc(
        "v4_invite_organization_member",
        {
          p_organization_id: access.organizationId,
          p_user_id: userId,
          p_role_key: roleKey,
          p_request_id: access.context.requestId,
        },
      );
      if (error || !data) {
        return NextResponse.json({ error: "membership_invitation_failed" }, { status: 409 });
      }
      return applyRequestAuthCookies(access.context, NextResponse.json(data, { status: 201 }));
    }
    if (action === "accept") {
      const context = await getRequestAuthContext(request);
      const organizationId = getRequestedOrganizationId(request);
      const membershipId = typeof body.membership_id === "string" ? body.membership_id : "";
      if (!organizationId || !membershipId) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      }
      const { data, error } = await context.supabase.rpc(
        "v4_accept_organization_membership",
        {
          p_organization_id: organizationId,
          p_membership_id: membershipId,
          p_request_id: context.requestId,
        },
      );
      if (error || !data) {
        return NextResponse.json({ error: "membership_acceptance_failed" }, { status: 409 });
      }
      return applyRequestAuthCookies(context, NextResponse.json(data));
    }
    return NextResponse.json({ error: "invalid_membership_action" }, { status: 400 });
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "membership_operation_unavailable" }, { status: 503 });
  }
}
