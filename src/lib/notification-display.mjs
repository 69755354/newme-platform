// Notification rows store an English title/body written by the server (and by
// reassign_lead_atomic() in the database). Recipients read Chinese or English,
// so the bell renders the lead notifications from translatable templates and
// keeps the stored text only as a fallback for anything it does not know.
// Works for rows written before this change too: it reads the stored text.

const LEAD_PATTERNS = [
  { field: "title", re: /^Possible duplicate lead to review: (.+)$/s, key: "leadFlow.duplicateReview.flaggedTitle" },
  { field: "body", re: /^Lead "(.+)" was created despite a possible duplicate$/s, key: "leadFlow.duplicateReview.flaggedBody" },
  { field: "title", re: /^New lead assigned: (.+)$/s, key: "leadFlow.notification.newLeadAssignedTitle" },
  { field: "title", re: /^New lead: (.+)$/s, key: "leadFlow.notification.newLeadTitle" },
  { field: "title", re: /^Lead assigned$/, key: "leadFlow.notification.leadAssignedTitle" },
  { field: "body", re: /^Lead "(.+)" has been assigned to you$/s, key: "leadFlow.notification.assignedToYouBody" },
  { field: "body", re: /^(.+) was assigned to you\.$/s, key: "leadFlow.notification.assignedToYouBody" },
  { field: "body", re: /^Lead "(.+)" is waiting for assignment$/s, key: "leadFlow.notification.waitingBody" },
  { field: "body", re: /^.+ created lead "(.+)"$/s, key: "leadFlow.notification.createdBody" },
  { field: "title", re: /^Lead not contacted yet: (.+)$/s, key: "leadFlow.notification.uncontactedTitle" },
  { field: "body", re: /^Lead "(.+)" has had no first contact for over 1 hour$/s, key: "leadFlow.notification.uncontactedBody" },
];

function render(template, name) {
  return template.replaceAll("{name}", name);
}

function localize(field, value, t) {
  if (typeof value !== "string" || !value) return value ?? null;
  for (const pattern of LEAD_PATTERNS) {
    if (pattern.field !== field) continue;
    const match = value.match(pattern.re);
    if (!match) continue;
    const template = t(pattern.key);
    // t() returns the key path itself when a string is missing.
    if (!template || template === pattern.key) return value;
    return render(template, match[1] ?? "");
  }
  return value;
}

// ── S41 (recheck §2-10, F14/B14/V7) ─────────────────────────────────────────────────────────────────────────────────
// Contract rows end in the raw status ("C-1 · AED 1,000 · pending_ceo"). The last " · code" segment is translated
// through the s37.codes dictionary (approval states) or s41.codes (the remaining contract/payment states); an unknown
// code is left as written.
const TRAILING_CODE = /^(.*) · ([a-z][a-z_]*)$/s;
const CODE_GROUPS = ["s37.codes", "s41.codes"];

function translateCode(code, t) {
  for (const group of CODE_GROUPS) {
    const key = `${group}.${code}`;
    const value = t(key);
    if (value && value !== key) return value;
  }
  return null;
}

function localizeTrailingCode(body, t) {
  if (typeof body !== "string") return body ?? null;
  const match = body.match(TRAILING_CODE);
  if (!match) return body;
  const translated = translateCode(match[2], t);
  return translated ? `${match[1]} · ${translated}` : body;
}

/**
 * Notification types a salesperson (or any non-management role) does not need in the bell: approval traffic between
 * operators, admin and boss, team administration, and stage/quote chatter about leads they already work on. What stays
 * is what asks them to act: a lead assigned or created for them, follow-up reminders, a contract approved or rejected,
 * payment states, KPI targets.
 */
export const SALES_HIDDEN_NOTIFICATION_TYPES = Object.freeze([
  "contract_pending_approval",
  "contract_created",
  "contract_signed",
  "contract_superseded",
  "team_member_added",
  "quote_created",
  "lead_stage_change",
  "lead_stage_changed",
]);

export const SALES_VISIBLE_NOTIFICATION_TYPES = Object.freeze([
  "lead_created",
  "lead_assigned",
  "follow_up_reminder",
  "follow_up_overdue",
  "followup_reminder",
  "reminder",
  "warning",
  "contract_approved",
  "contract_rejected",
  "payment_due",
  "payment_overdue",
  "payment_received",
  "first_payment_reminder",
  "kpi_target_set",
]);

const MANAGEMENT_ROLES = ["admin", "boss", "operator"];

/** null = every type (management); otherwise the list of types to show, for both the badge and the list. */
export function notificationTypesForRole(role) {
  if (MANAGEMENT_ROLES.includes(role)) return null;
  return [...SALES_VISIBLE_NOTIFICATION_TYPES];
}

/** Localised { title, body } for one notification row. */
export function localizeNotification(notification, t) {
  return {
    title: localize("title", notification?.title, t),
    body: localizeTrailingCode(localize("body", notification?.body, t), t),
  };
}
