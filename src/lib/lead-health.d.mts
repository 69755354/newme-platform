export const RECENT_CONTACT_DAYS: number;
export const FRESH_LEAD_HOURS: number;
export function hasRecentContact(input: {
  lead: { last_contact_date?: string | null; followup_count?: number | null };
  followUpLogs?: Array<{ contact_time?: string | null; created_at?: string | null }>;
  now?: Date;
}): boolean;
export function isFreshLead(lead: { created_at?: string | null }, now?: Date): boolean;
export function healthBadgeLevel(
  level: "healthy" | "at_risk" | "stale",
  lead: { created_at?: string | null },
  now?: Date,
): "healthy" | "at_risk" | "stale" | "fresh";
