import "server-only";
import { supabaseAdmin } from "./supabase-admin";

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

export interface NotificationDraft {
  userId: string;
  // Dedicated server-side notification producers predate the public event
  // registry and also persist internal-only types (for example revocations).
  // The public /api/notify route still validates against NotificationType.
  type: string;
  title: string;
  body?: string;
  relatedId?: string;
  relatedType?: string;
  /** Stable persisted occurrence. Undefined means a repeatable delivery intent. */
  eventKey?: string;
}

export interface NotificationWriteResult {
  created: number;
  skipped: number;
}

export class NotificationPersistenceError extends Error {
  readonly operation: string;
  readonly code: string | null;

  constructor(operation: string, error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "") || null
      : null;
    super(`${operation}${code ? ` (${code})` : ""}`);
    this.name = "NotificationPersistenceError";
    this.operation = operation;
    this.code = code;
    this.cause = error;
  }
}

/**
 * Server-side helper to create a notification.
 * Called from API routes or server components when events occur.
 */
export async function createNotification(
  params: NotificationDraft,
): Promise<NotificationWriteResult> {
  return createNotificationsBulk([params]);
}

/**
 * Create notifications for multiple users at once (e.g., notify all admins/bosses).
 */
export async function createNotificationsBulk(
  notifications: NotificationDraft[],
): Promise<NotificationWriteResult> {
  // Collapse only rows that explicitly name the same persisted occurrence. A
  // missing eventKey is a new delivery intent (for example, a human choosing to
  // send the same reminder again), so presentation fields must not create a
  // lifetime uniqueness rule for it.
  const candidates: NotificationDraft[] = [];
  const seenOccurrences = new Set<string>();
  for (const notification of notifications) {
    if (notification.eventKey !== undefined) {
      const key = [notification.userId, notification.eventKey].join("\u001f");
      if (seenOccurrences.has(key)) continue;
      seenOccurrences.add(key);
    }
    candidates.push(notification);
  }

  if (candidates.length === 0) return { created: 0, skipped: 0 };

  const rows = candidates.map((n) => ({
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body || null,
    related_id: n.relatedId || null,
    related_type: n.relatedType || null,
    event_key: n.eventKey ?? null,
  }));

  const { data, error } = await supabaseAdmin.rpc("insert_notifications_atomic", {
    p_notifications: rows,
  });
  if (error) throw new NotificationPersistenceError("notification_insert_failed", error);

  const result = data as { created?: unknown; skipped?: unknown } | null;
  if (
    !result
    || typeof result.created !== "number"
    || typeof result.skipped !== "number"
    || !Number.isInteger(result.created)
    || !Number.isInteger(result.skipped)
    || result.created < 0
    || result.skipped < 0
    || result.created + result.skipped !== rows.length
  ) {
    throw new NotificationPersistenceError("notification_insert_result_invalid", null);
  }

  return {
    created: result.created,
    skipped: (notifications.length - rows.length) + result.skipped,
  };
}

/**
 * Get all admin/boss user IDs for notification dispatch.
 */
export async function getAdminUserIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .in("role", ["admin", "boss"])
    .eq("is_active", true);

  if (error) throw new NotificationPersistenceError("notification_admin_lookup_failed", error);
  if (!data) return [];
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

  if (error) throw new NotificationPersistenceError("notification_recipient_lookup_failed", error);
  if (!data) return [];

  let ids = data.map((p) => p.id);
  if (excludeUserId) {
    ids = ids.filter((id) => id !== excludeUserId);
  }
  return ids;
}
