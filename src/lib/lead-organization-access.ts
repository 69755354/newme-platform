import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  getRequestAuthContext,
  type RequestAuthContext,
} from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import {
  getRequestedOrganizationId,
  parseOrganizationId,
  SUPPORT_SESSION_HEADER,
} from "@/lib/organization-context";

export type LeadOrganizationScope = "lead:read" | "lead:write";

export class LeadOrganizationAccessError extends Error {
  readonly status: 400 | 403 | 503;
  readonly code: string;

  constructor(status: 400 | 403 | 503, code: string) {
    super(code);
    this.name = "LeadOrganizationAccessError";
    this.status = status;
    this.code = code;
  }
}

export interface LeadOrganizationAccess {
  client: SupabaseClient<Database>;
  context: RequestAuthContext;
  organizationId: string;
  supportSessionId: string | null;
}

function hasScope(value: unknown, requiredScope: LeadOrganizationScope): boolean {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string")
    && value.includes(requiredScope);
}

export async function resolveLeadOrganizationAccess(
  request: Request,
  requiredScope: LeadOrganizationScope,
  targetType: string,
  targetId: string | null,
): Promise<LeadOrganizationAccess> {
  const context = await getRequestAuthContext(request);
  const organizationId = getRequestedOrganizationId(request);
  if (!organizationId) {
    throw new LeadOrganizationAccessError(400, "organization_context_required");
  }

  try {
    const authorization = await resolveOrganizationAuthorization(
      request,
      requiredScope === "lead:write" ? "leads.write" : "leads.read",
      requiredScope === "lead:write" ? "write" : "read",
    );
    return {
      client: authorization.context.supabase,
      context: authorization.context,
      organizationId,
      supportSessionId: null,
    };
  } catch (error) {
    if (
      !(error instanceof OrganizationAuthorizationError)
      || ![
        "active_organization_membership_required",
        "organization_role_required",
        "organization_capability_required",
      ].includes(error.code)
    ) {
      if (error instanceof OrganizationAuthorizationError) {
        throw new LeadOrganizationAccessError(error.status, error.code);
      }
      throw error;
    }
  }

  const supportSessionId = parseOrganizationId(
    request.headers.get(SUPPORT_SESSION_HEADER),
  );
  if (!supportSessionId) {
    throw new LeadOrganizationAccessError(403, "active_organization_membership_required");
  }

  const { data: staff, error: staffError } = await supabaseAdmin
    .from("platform_staff")
    .select("id")
    .eq("user_id", context.user.id)
    .eq("status", "active")
    .maybeSingle();
  if (staffError) {
    throw new LeadOrganizationAccessError(503, "support_access_unavailable");
  }
  if (!staff) {
    throw new LeadOrganizationAccessError(403, "platform_staff_required");
  }

  const { data: supportSession, error: supportError } = await supabaseAdmin
    .from("support_sessions")
    .select("id, organization_id, platform_staff_id, scope, status, expires_at, revoked_at")
    .eq("id", supportSessionId)
    .eq("organization_id", organizationId)
    .eq("platform_staff_id", staff.id)
    .maybeSingle();
  if (supportError) {
    throw new LeadOrganizationAccessError(503, "support_access_unavailable");
  }

  const supportAllowed = Boolean(
    supportSession
      && supportSession.status === "active"
      && supportSession.revoked_at === null
      && new Date(supportSession.expires_at).getTime() > Date.now()
      && hasScope(supportSession.scope, requiredScope),
  );

  const { error: auditError } = await supabaseAdmin.from("audit_events").insert({
    organization_id: organizationId,
    actor_user_id: context.user.id,
    actor_platform_staff_id: staff.id,
    support_session_id: supportSession?.id ?? null,
    action: `support.${requiredScope}`,
    target_type: targetType,
    target_id: targetId,
    outcome: supportAllowed ? "success" : "denied",
    reason: supportAllowed ? "approved_support_session" : "invalid_support_session",
    request_id: context.requestId,
    metadata: {},
  });
  if (auditError) {
    throw new LeadOrganizationAccessError(503, "support_audit_required");
  }
  if (!supportAllowed) {
    throw new LeadOrganizationAccessError(403, "support_session_not_authorized");
  }

  return {
    client: supabaseAdmin as unknown as SupabaseClient<Database>,
    context,
    organizationId,
    supportSessionId,
  };
}

