import { supabaseAdmin } from "./supabase-admin";
import * as fs from "fs";
import * as path from "path";

const NOTIFICATION_ERROR_LOG = path.join(process.cwd(), "logs", "notification-errors.log");

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
    console.error("[Notifications] Failed to create notification:", error);
    try {
      const dir = path.dirname(NOTIFICATION_ERROR_LOG);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(NOTIFICATION_ERROR_LOG, JSON.stringify({ ts: new Date().toISOString(), error: error.message, params: { userId, type } }) + "\n");
    } catch {}
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
    console.error("[Notifications] Bulk insert failed:", error);
    try {
      const dir = path.dirname(NOTIFICATION_ERROR_LOG);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(NOTIFICATION_ERROR_LOG, JSON.stringify({ ts: new Date().toISOString(), error: error.message, count: rows.length }) + "\n");
    } catch {}
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
    console.error("[Notifications] Failed to fetch admin user IDs:", error);
    return [];
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
    console.error("[Notifications] Failed to fetch active user IDs:", error);
    return [];
  }

  let ids = data.map((p) => p.id);
  if (excludeUserId) {
    ids = ids.filter((id) => id !== excludeUserId);
  }
  return ids;
}
