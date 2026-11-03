// Notification rows store an English title/body written by the server (and by
// reassign_lead_atomic() in the database). Recipients read Chinese or English,
// so the bell renders the lead notifications from translatable templates and
// keeps the stored text only as a fallback for anything it does not know.
// Works for rows written before this change too: it reads the stored text.

const LEAD_PATTERNS = [
  { field: "title", re: /^New lead assigned: (.+)$/s, key: "leadFlow.notification.newLeadAssignedTitle" },
  { field: "title", re: /^New lead: (.+)$/s, key: "leadFlow.notification.newLeadTitle" },
  { field: "title", re: /^Lead assigned$/, key: "leadFlow.notification.leadAssignedTitle" },
  { field: "body", re: /^Lead "(.+)" has been assigned to you$/s, key: "leadFlow.notification.assignedToYouBody" },
  { field: "body", re: /^(.+) was assigned to you\.$/s, key: "leadFlow.notification.assignedToYouBody" },
  { field: "body", re: /^Lead "(.+)" is waiting for assignment$/s, key: "leadFlow.notification.waitingBody" },
  { field: "body", re: /^.+ created lead "(.+)"$/s, key: "leadFlow.notification.createdBody" },
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

/** Localised { title, body } for one notification row. */
export function localizeNotification(notification, t) {
  return {
    title: localize("title", notification?.title, t),
    body: localize("body", notification?.body, t),
  };
}
