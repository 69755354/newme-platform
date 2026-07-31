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

/**
 * Server-side helper to create a notification.
 * Called from API routes or server components when events occur.
 */
export async function createNotification(params: {
  userId: string;
  type: string;
  title: string;
  body?: string;
  relatedId?: string;
  relatedType?: string;
}) {
  const { userId, type, title, body, relatedId, relatedType } = params;

  const { error } = await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    type,
    title,
    body: body || null,
    related_id: relatedId || null,
    related_type: relatedType || null,
  });

  if (error) {
    return failNotificationOperation("single_insert", "notification_insert_failed");
  }
}

/**
 * Create notifications for multiple users at once (e.g., notify all admins/bosses).
 */
export async function createNotificationsBulk(
  notifications: {
    userId: string;
    type: string;
    title: string;
    body?: string;
    relatedId?: string;
    relatedType?: string;
  }[]
) {
  const rows = notifications.map((n) => ({
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body || null,
    related_id: n.relatedId || null,
    related_type: n.relatedType || null,
  }));

  const { error } = await supabaseAdmin.from("notifications").insert(rows);
  if (error) {
    return failNotificationOperation("bulk_insert", "notification_bulk_insert_failed");
  }
}

/**
 * Get all admin/boss user IDs for notification dispatch.
 */
export async function getAdminUserIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .in("role", ["admin", "boss"]);

  if (error || !data) {
    return failNotificationOperation("admin_recipient_lookup", "notification_recipient_lookup_failed");
  }
  return data.map((p) => p.id);
}

/**
 * Get all active user IDs for notification broadcast.
 * Optionally excludes a specific user (e.g., the person who triggered the event).
 */
export async function getAllActiveUserIds(excludeUserId?: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("is_active", true);

  if (error || !data) {
    return failNotificationOperation("active_recipient_lookup", "notification_recipient_lookup_failed");
  }

  let ids = data.map((p) => p.id);
  if (excludeUserId) {
    ids = ids.filter((id) => id !== excludeUserId);
  }
  return ids;
}
