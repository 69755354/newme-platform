import { supabaseAdmin } from "./supabase-admin";
import { createIntegrationLogSinks } from "./integration-execution.mjs";
import { genReqId, logger } from "./logger";

async function failNotificationOperation(operation: string, reason: string): Promise<never> {
  const sinks = createIntegrationLogSinks({
    logger,
    requestId: genReqId(),
    route: "notification_helper",
  });
  const event = {
    integration: "in_app_notification",
    operation,
    outcome: "failure",
    attempts: 1,
    reason,
  };
  await sinks.audit(event);
  await sinks.alert(event);
  throw new Error(reason);
}

/**
 * Shared list of valid notification types.
 * Used by both /api/notify and /api/notifications for validation.
 */
export const VALID_NOTIFICATION_TYPES = [
  "lead_created", "lead_assigned", "lead_stage_change", "lead_stage_changed",
  "quote_created", "contract_created", "contract_signed",
  "contract_pending_approval", "contract_approved", "contract_rejected",
  "payment_due", "payment_overdue", "payment_received",
  "kpi_target_set", "followup_reminder", "team_member_added",
  "follow_up_overdue", "first_payment_reminder",
] as const;

export type NotificationType = typeof VALID_NOTIFICATION_TYPES[number];

async function activeOrganizationUserIds(
  organizationId: string,
  requestedUserIds?: string[],
): Promise<string[]> {
  let membershipQuery = supabaseAdmin
    .from("memberships")
    .select("id, user_id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .not("accepted_at", "is", null);
  if (requestedUserIds) {
    if (requestedUserIds.length === 0) return [];
    membershipQuery = membershipQuery.in("user_id", requestedUserIds);
  }
  const { data: memberships, error: membershipError } = await membershipQuery;
  if (membershipError || !memberships) {
    return failNotificationOperation(
      "membership_recipient_lookup",
      "notification_recipient_lookup_failed",
    );
  }
  const memberIds = [...new Set(memberships.map((membership) => membership.user_id))];
  if (memberIds.length === 0) return [];
  const { data: profiles, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .in("id", memberIds)
    .eq("is_active", true);
  if (profileError || !profiles) {
    return failNotificationOperation(
      "profile_recipient_lookup",
      "notification_recipient_lookup_failed",
    );
  }
  return profiles.map((profile) => profile.id);
}

/**
 * Server-side helper to create a notification.
 * Called from API routes or server components when events occur.
 */
export async function createNotification(params: {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  relatedId?: string;
  relatedType?: string;
  eventKey?: string;
}) {
  const { organizationId, userId, type, title, body, relatedId, relatedType, eventKey } = params;
  const activeRecipients = await activeOrganizationUserIds(organizationId, [userId]);
  if (!activeRecipients.includes(userId)) {
    return failNotificationOperation("single_recipient_scope", "notification_recipient_not_active_member");
  }

  const row = {
    organization_id: organizationId,
    user_id: userId,
    type,
    title,
    body: body || null,
    related_id: relatedId || null,
    related_type: relatedType || null,
    event_key: eventKey || null,
  };
  const { error } = eventKey
    ? await supabaseAdmin.from("notifications").upsert(row, {
        onConflict: "organization_id,user_id,event_key",
        ignoreDuplicates: true,
      })
    : await supabaseAdmin.from("notifications").insert(row);

  if (error) {
    if (eventKey && error.code === "23505") return;
    return failNotificationOperation("single_insert", "notification_insert_failed");
  }
}

/**
 * Create notifications for multiple users at once (e.g., notify all admins/bosses).
 */
export async function createNotificationsBulk(
  organizationId: string,
  notifications: {
    userId: string;
    type: string;
    title: string;
    body?: string;
    relatedId?: string;
    relatedType?: string;
    eventKey?: string;
  }[]
) {
  if (notifications.length === 0) return;
  const requestedUserIds = [...new Set(notifications.map((notification) => notification.userId))];
  const activeRecipientIds = new Set(
    await activeOrganizationUserIds(organizationId, requestedUserIds),
  );
  if (activeRecipientIds.size !== requestedUserIds.length) {
    return failNotificationOperation("bulk_recipient_scope", "notification_recipient_not_active_member");
  }
  const rows = notifications.map((n) => ({
    organization_id: organizationId,
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body || null,
    related_id: n.relatedId || null,
    related_type: n.relatedType || null,
    event_key: n.eventKey || null,
  }));

  const { error } = notifications.every((notification) => notification.eventKey)
    ? await supabaseAdmin.from("notifications").upsert(rows, {
        onConflict: "organization_id,user_id,event_key",
        ignoreDuplicates: true,
      })
    : await supabaseAdmin.from("notifications").insert(rows);
  if (error) {
    if (notifications.every((notification) => notification.eventKey) && error.code === "23505") return;
    return failNotificationOperation("bulk_insert", "notification_bulk_insert_failed");
  }
}

/**
 * Get all admin/boss user IDs for notification dispatch.
 */
export async function getAdminUserIds(organizationId: string): Promise<string[]> {
  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from("memberships")
    .select("id, user_id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .not("accepted_at", "is", null);
  if (membershipError || !memberships) {
    return failNotificationOperation("admin_recipient_lookup", "notification_recipient_lookup_failed");
  }
  const membershipIds = memberships.map((membership) => membership.id);
  if (membershipIds.length === 0) return [];
  const { data: roleLinks, error: roleLinkError } = await supabaseAdmin
    .from("membership_roles")
    .select("membership_id, role_id")
    .eq("organization_id", organizationId)
    .in("membership_id", membershipIds)
    .is("revoked_at", null);
  if (roleLinkError || !roleLinks) {
    return failNotificationOperation("admin_role_lookup", "notification_recipient_lookup_failed");
  }
  const roleIds = [...new Set(roleLinks.map((roleLink) => roleLink.role_id))];
  if (roleIds.length === 0) return [];
  const { data: roles, error: roleError } = await supabaseAdmin
    .from("roles")
    .select("id")
    .in("id", roleIds)
    .eq("scope", "organization")
    .in("role_key", ["org_owner", "org_admin"]);
  if (roleError || !roles) {
    return failNotificationOperation("admin_role_lookup", "notification_recipient_lookup_failed");
  }
  const adminRoleIds = new Set(roles.map((role) => role.id));
  const adminMembershipIds = new Set(
    roleLinks
      .filter((roleLink) => adminRoleIds.has(roleLink.role_id))
      .map((roleLink) => roleLink.membership_id),
  );
  const candidateIds = memberships
    .filter((membership) => adminMembershipIds.has(membership.id))
    .map((membership) => membership.user_id);
  return activeOrganizationUserIds(organizationId, candidateIds);
}

/**
 * Get all active user IDs for notification broadcast.
 * Optionally excludes a specific user (e.g., the person who triggered the event).
 */
export async function getAllActiveUserIds(
  organizationId: string,
  excludeUserId?: string,
): Promise<string[]> {
  let ids = await activeOrganizationUserIds(organizationId);
  if (excludeUserId) {
    ids = ids.filter((id) => id !== excludeUserId);
  }
  return ids;
}
