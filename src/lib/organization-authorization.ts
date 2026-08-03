import "server-only";

import {
  getRequestAuthContext,
  type RequestAuthContext,
} from "@/lib/request-auth-context";
import { getRequestedOrganizationId } from "@/lib/organization-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

export class OrganizationAuthorizationError extends Error {
  readonly status: 400 | 403 | 503;
  readonly code: string;
  readonly context: RequestAuthContext;

  constructor(
    status: 400 | 403 | 503,
    code: string,
    context: RequestAuthContext,
  ) {
    super(code);
    this.name = "OrganizationAuthorizationError";
    this.status = status;
    this.code = code;
    this.context = context;
  }
}

export interface OrganizationAuthorization {
  context: RequestAuthContext;
  organizationId: string;
  organizationStatus: string;
  membershipId: string;
  roleKeys: string[];
  capabilities: string[];
}

async function resolveRoleCapabilities(
  roleIds: string[],
  context: RequestAuthContext,
) {
  if (roleIds.length === 0) return [];

  const { data: links, error: linksError } = await supabaseAdmin
    .from("role_capabilities")
    .select("capability_id")
    .in("role_id", roleIds);
  if (linksError) {
    throw new OrganizationAuthorizationError(
      503,
      "organization_capability_lookup_failed",
      context,
    );
  }
  const capabilityIds = [
    ...new Set((links ?? []).map((link) => link.capability_id)),
  ];
  if (capabilityIds.length === 0) return [];

  const { data: capabilities, error: capabilitiesError } = await supabaseAdmin
    .from("capabilities")
    .select("capability_key")
    .eq("scope", "organization")
    .in("id", capabilityIds);
  if (capabilitiesError) {
    throw new OrganizationAuthorizationError(
      503,
      "organization_capability_lookup_failed",
      context,
    );
  }
  return [...new Set(
    (capabilities ?? []).map((capability) => capability.capability_key),
  )].sort();
}

export async function resolveOrganizationAuthorization(
  request: Request,
  requiredCapability: string,
  accessMode: "read" | "write" | "export" = "read",
): Promise<OrganizationAuthorization> {
  const context = await getRequestAuthContext(request);
  const organizationId = getRequestedOrganizationId(request);
  if (!organizationId) {
    throw new OrganizationAuthorizationError(
      400,
      "organization_context_required",
      context,
    );
  }

  const { data: organization, error: organizationError } = await supabaseAdmin
    .from("organizations")
    .select("id, status")
    .eq("id", organizationId)
    .maybeSingle();
  if (organizationError) {
    throw new OrganizationAuthorizationError(
      503,
      "organization_lookup_failed",
      context,
    );
  }
  const allowedStatuses = accessMode === "write"
    ? ["active"]
    : accessMode === "export"
      ? ["active", "read_only", "suspended", "export_only"]
      : ["active", "read_only"];
  if (!organization || !allowedStatuses.includes(organization.status)) {
    throw new OrganizationAuthorizationError(
      403,
      "organization_unavailable",
      context,
    );
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from("memberships")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("user_id", context.user.id)
    .eq("status", "active")
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (membershipError) {
    throw new OrganizationAuthorizationError(
      503,
      "organization_membership_lookup_failed",
      context,
    );
  }
  if (!membership) {
    throw new OrganizationAuthorizationError(
      403,
      "active_organization_membership_required",
      context,
    );
  }

  const { data: assignments, error: assignmentsError } = await supabaseAdmin
    .from("membership_roles")
    .select("role_id")
    .eq("membership_id", membership.id)
    .is("revoked_at", null);
  if (assignmentsError) {
    throw new OrganizationAuthorizationError(
      503,
      "organization_role_lookup_failed",
      context,
    );
  }
  const roleIds = [...new Set((assignments ?? []).map((row) => row.role_id))];
  if (roleIds.length === 0) {
    throw new OrganizationAuthorizationError(
      403,
      "organization_role_required",
      context,
    );
  }

  const { data: roles, error: rolesError } = await supabaseAdmin
    .from("roles")
    .select("id, role_key")
    .eq("scope", "organization")
    .in("id", roleIds);
  if (rolesError) {
    throw new OrganizationAuthorizationError(
      503,
      "organization_role_lookup_failed",
      context,
    );
  }
  const roleKeys = [...new Set((roles ?? []).map((role) => role.role_key))]
    .sort();
  const validRoleIds = (roles ?? []).map((role) => role.id);
  const capabilities = await resolveRoleCapabilities(validRoleIds, context);
  if (!capabilities.includes(requiredCapability)) {
    throw new OrganizationAuthorizationError(
      403,
      "organization_capability_required",
      context,
    );
  }

  return {
    context,
    organizationId,
    organizationStatus: organization.status,
    membershipId: membership.id,
    roleKeys,
    capabilities,
  };
}
