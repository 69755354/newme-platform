import "server-only";

import {
  getRequestAuthContext,
  type RequestAuthContext,
} from "@/lib/request-auth-context";
import { getRequestedOrganizationId } from "@/lib/organization-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

export class OrganizationMemberAdminError extends Error {
  readonly status: 400 | 403 | 404 | 503;
  readonly code: string;

  constructor(status: 400 | 403 | 404 | 503, code: string) {
    super(code);
    this.name = "OrganizationMemberAdminError";
    this.status = status;
    this.code = code;
  }
}

export interface OrganizationMemberAdminAccess {
  context: RequestAuthContext;
  organizationId: string;
  callerMembershipId: string;
}

export async function resolveOrganizationMemberAdminAccess(
  request: Request,
): Promise<OrganizationMemberAdminAccess> {
  const context = await getRequestAuthContext(request);
  const organizationId = getRequestedOrganizationId(request);
  if (!organizationId) {
    throw new OrganizationMemberAdminError(
      400,
      "organization_context_required",
    );
  }
  if (!["admin", "boss"].includes(context.role)) {
    throw new OrganizationMemberAdminError(403, "organization_admin_required");
  }

  const { data: membership, error } = await supabaseAdmin
    .from("memberships")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("user_id", context.user.id)
    .eq("status", "active")
    .maybeSingle();
  if (error) {
    throw new OrganizationMemberAdminError(
      503,
      "organization_membership_lookup_failed",
    );
  }
  if (!membership) {
    throw new OrganizationMemberAdminError(
      403,
      "active_organization_membership_required",
    );
  }

  return {
    context,
    organizationId,
    callerMembershipId: membership.id,
  };
}

export async function requireOrganizationMembership(
  organizationId: string,
  userId: string,
  statuses: string[] = ["active"],
) {
  const { data, error } = await supabaseAdmin
    .from("memberships")
    .select("id, organization_id, user_id, status, version")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .in("status", statuses)
    .maybeSingle();
  if (error) {
    throw new OrganizationMemberAdminError(
      503,
      "target_membership_lookup_failed",
    );
  }
  if (!data) {
    throw new OrganizationMemberAdminError(404, "member_not_found");
  }
  return data;
}

export async function activeOrganizationMemberIds(
  organizationId: string,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("status", "active");
  if (error) {
    throw new OrganizationMemberAdminError(
      503,
      "organization_memberships_fetch_failed",
    );
  }
  return [...new Set((data ?? []).map((row) => row.user_id))];
}
