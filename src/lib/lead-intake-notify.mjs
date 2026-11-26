// S35: a lead that arrives by itself (Meta lead form, WhatsApp ad / direct message, website form, drive-sheet sync) must
// tell somebody at once. Assigned lead -> its owner; unassigned lead -> the people who hand leads out (admin, boss and
// the operator who works the dispatch queue). One persisted notification per person and lead: the event key is the same
// `lead_created:<lead id>` the manual lead creation uses, so webhook retries, backfills and a manual path can never
// double-notify. Titles and bodies are the stable English templates the notification bell already localises (zh + en,
// src/lib/notification-display.mjs). Works with any Supabase client (route, script).

import { withCoverRecipients } from "./leave-cover.mjs";

export const INTAKE_QUEUE_ROLES = Object.freeze(["admin", "boss", "operator"]);
/** A lead older than this is history (a backfill or a re-synced row), not a new arrival: nobody is pinged. */
export const INTAKE_MAX_AGE_MS = 24 * 3_600_000;
const MAX_RECIPIENTS = 64;

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/** Pure: the notification rows for one new lead and its recipients. */
export function intakeNotificationRows(lead, recipientIds, assigned) {
  const customer = clean(lead.customer_name) || "New Lead";
  return [...new Set(recipientIds)].slice(0, MAX_RECIPIENTS).map((userId) => ({
    user_id: userId,
    type: "lead_created",
    title: `New lead: ${customer}`,
    body: assigned ? `Lead "${customer}" has been assigned to you` : `Lead "${customer}" is waiting for assignment`,
    related_id: lead.id,
    related_type: "lead",
    event_key: `lead_created:${lead.id}`,
  }));
}

async function activeIds(db, query) {
  const { data, error } = await query;
  if (error) throw new Error("notification_recipient_lookup_failed");
  return (data ?? []).map((p) => p.id);
}

/**
 * Notify about one new lead. lead: { id, customer_name, assigned_to, created_at }.
 * Returns { created, skipped, reason? }. Throws only on a database failure (callers decide whether that is fatal).
 */
export async function notifyNewLead(db, lead, { now = Date.now(), maxAgeMs = INTAKE_MAX_AGE_MS } = {}) {
  if (!lead?.id) return { created: 0, skipped: 0, reason: "no_lead" };
  const createdMs = Date.parse(lead.created_at ?? "");
  if (Number.isFinite(createdMs) && now - createdMs > maxAgeMs) return { created: 0, skipped: 0, reason: "too_old" };
  let recipients = [];
  let assigned = false;
  if (lead.assigned_to) {
    recipients = await activeIds(db, db.from("profiles").select("id").eq("is_active", true).in("id", [lead.assigned_to]));
    assigned = recipients.length > 0;
    // S43: the owner's leave cover (default off, NEWME_LEAVE_COVER_ENABLED) is told too.
    if (assigned) recipients = await withCoverRecipients(db, recipients, { now: new Date(now) });
  }
  if (!assigned) {
    recipients = await activeIds(db, db.from("profiles").select("id").eq("is_active", true).in("role", [...INTAKE_QUEUE_ROLES]));
  }
  const rows = intakeNotificationRows(lead, recipients, assigned);
  if (rows.length === 0) return { created: 0, skipped: 0, reason: "no_recipients" };
  const { data, error } = await db.rpc("insert_notifications_atomic", { p_notifications: rows });
  if (error) throw new Error("notification_insert_failed");
  return { created: Number(data?.created ?? 0), skipped: Number(data?.skipped ?? 0) };
}

/** Never throws: a failed ping must not fail the intake that stored the lead. onError gets a reason code only. */
export async function notifyNewLeadSafe(db, lead, { onError, ...options } = {}) {
  try {
    return await notifyNewLead(db, lead, options);
  } catch (error) {
    try { onError?.(error instanceof Error ? error.message : "notification_failed"); } catch { /* logging must not throw */ }
    return { created: 0, skipped: 0, reason: "error" };
  }
}
