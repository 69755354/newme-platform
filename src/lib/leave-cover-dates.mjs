// S43 (B13): the date-only half of the leave cover — no database, safe to import from the browser (team page panel).
import { dubaiDateKey } from "./dubai-time.mjs";

const dateKey = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/**
 * The cover's id when the profile's cover is active on the given day (Dubai date), else null.
 * @param {{ id?: string, cover_user_id?: string|null, cover_start?: string|null, cover_end?: string|null } | null | undefined} profile
 * @param {Date|number|string} [now]
 */
export function activeCoverId(profile, now = new Date()) {
  if (!profile?.cover_user_id || profile.cover_user_id === profile.id) return null;
  const start = dateKey(profile.cover_start);
  const end = dateKey(profile.cover_end);
  const today = dubaiDateKey(now instanceof Date ? now : new Date(now));
  if (!start || !end || !today) return null;
  return start <= today && today <= end ? profile.cover_user_id : null;
}
