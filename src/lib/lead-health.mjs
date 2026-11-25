// S41 (recheck §2-3, F11 / N1): the health badge on a lead page. The old input was "followup_count > 0", but 记一笔 and
// the quick quote write follow_up_logs / last_contact_date without touching that counter, so a lead contacted a minute
// ago read "Stale". Recent contact now means: last_contact_date within 7 days, or any follow_up_logs row within 7 days.
// A lead created less than 48 hours ago is never shown as Stale either: it is simply new.

const DAY_MS = 86_400_000;
export const RECENT_CONTACT_DAYS = 7;
export const FRESH_LEAD_HOURS = 48;

function withinDays(value, days, now) {
  if (!value) return false;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return false;
  return now.getTime() - ms <= days * DAY_MS;
}

/**
 * @param {{ lead: { last_contact_date?: string|null, followup_count?: number|null }, followUpLogs?: Array<{ contact_time?: string|null, created_at?: string|null }>, now?: Date }} input
 */
export function hasRecentContact({ lead, followUpLogs = [], now = new Date() }) {
  if (withinDays(lead?.last_contact_date, RECENT_CONTACT_DAYS, now)) return true;
  return followUpLogs.some((log) => withinDays(log?.contact_time ?? log?.created_at, RECENT_CONTACT_DAYS, now));
}

/** Created less than FRESH_LEAD_HOURS ago. */
export function isFreshLead(lead, now = new Date()) {
  const created = lead?.created_at ? new Date(lead.created_at).getTime() : NaN;
  if (Number.isNaN(created)) return false;
  return now.getTime() - created < FRESH_LEAD_HOURS * 3_600_000;
}

/**
 * The level the badge shows: a stale score on a fresh lead becomes "fresh" (shown as "New lead"), every other level
 * is shown as computed.
 * @param {"healthy"|"at_risk"|"stale"} level
 * @returns {"healthy"|"at_risk"|"stale"|"fresh"}
 */
export function healthBadgeLevel(level, lead, now = new Date()) {
  if (level === "stale" && isFreshLead(lead, now)) return "fresh";
  return level;
}
