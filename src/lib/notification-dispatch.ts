import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  deriveNotificationDispatch,
  NotificationDispatchError,
  type NotificationEventInput,
} from "@/lib/notification-events";
import { createNotificationsBulk, type NotificationWriteResult } from "@/lib/notifications";
import type { Database } from "@/types/database";

/**
 * Dispatch an already-committed business event from server-side code without
 * making a loopback HTTP request. Actor identity and role are re-read from the
 * database; the event resolver then re-reads the referenced business entity.
 */
export async function dispatchPersistedNotification(options: {
  actorId: string;
  input: NotificationEventInput;
  db?: SupabaseClient<Database>;
  now?: Date;
}): Promise<NotificationWriteResult> {
  const db = options.db ?? (supabaseAdmin as SupabaseClient<Database>);
  const { data: profile, error } = await db
    .from("profiles")
    .select("id, role, full_name, email, is_active")
    .eq("id", options.actorId)
    .maybeSingle();
  if (error) throw new NotificationDispatchError(503, "notification_actor_lookup_failed");
  if (!profile || profile.is_active !== true) {
    throw new NotificationDispatchError(403, "notification_actor_inactive");
  }

  const drafts = await deriveNotificationDispatch({
    db,
    actor: {
      id: profile.id,
      role: profile.role ?? "sales",
      fullName: profile.full_name || profile.email || "User",
    },
    input: options.input,
    now: options.now,
  });
  return createNotificationsBulk(drafts);
}
