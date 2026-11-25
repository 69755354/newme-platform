// S43 (B13): leave cover. A profile may name a colleague (profiles.cover_user_id) for a date range
// (cover_start .. cover_end, Dubai calendar days, inclusive). While the cover is active, whatever the
// person on leave would be told about a new lead (assignment notification, reminders, follow-up alerts)
// is also told to the cover. Default off: NEWME_LEAVE_COVER_ENABLED=true turns the routing on; the
// columns can be set and shown either way.
import { dubaiDateKey } from "./dubai-time.mjs";

export const LEAVE_COVER_SWITCH = "NEWME_LEAVE_COVER_ENABLED";
export const COVER_COLUMNS = "id, is_active, cover_user_id, cover_start, cover_end";

export function leaveCoverEnabled(env = process.env) {
  return String(env?.[LEAVE_COVER_SWITCH] ?? "").trim().toLowerCase() === "true";
}

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

/**
 * Pure: the user ids plus the active cover of each (covers that are inactive profiles are left out).
 * `profiles` must contain the rows for userIds (with the cover columns) and, when known, the cover rows.
 */
export function expandWithCovers(userIds, profiles, now = new Date()) {
  const byId = new Map((profiles ?? []).filter((p) => p?.id).map((p) => [p.id, p]));
  const out = [];
  const seen = new Set();
  const add = (id) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
  for (const id of userIds ?? []) {
    add(id);
    const cover = activeCoverId(byId.get(id), now);
    if (!cover) continue;
    const coverProfile = byId.get(cover);
    if (coverProfile && coverProfile.is_active === false) continue;
    add(cover);
  }
  return out;
}

/**
 * The recipients plus their active covers, read from the database. With the switch off (default) the
 * ids come back unchanged and nothing is read. Throws only on a database error.
 * @param {{ from: (table: string) => any }} db
 * @param {Array<string|null|undefined>} userIds
 */
export async function withCoverRecipients(db, userIds, { now = new Date(), env = process.env } = {}) {
  const ids = [...new Set((userIds ?? []).filter(Boolean))];
  if (!leaveCoverEnabled(env) || ids.length === 0) return ids;
  const people = await db.from("profiles").select(COVER_COLUMNS).in("id", ids);
  if (people.error) throw new Error("leave_cover_lookup_failed");
  const coverIds = [...new Set((people.data ?? []).map((p) => activeCoverId(p, now)).filter(Boolean))].filter((id) => !ids.includes(id));
  let covers = [];
  if (coverIds.length) {
    const found = await db.from("profiles").select(COVER_COLUMNS).in("id", coverIds).eq("is_active", true);
    if (found.error) throw new Error("leave_cover_lookup_failed");
    covers = found.data ?? [];
  }
  // A cover that was not returned as active is dropped by expandWithCovers (marked inactive here).
  const known = new Set(covers.map((c) => c.id));
  const placeholders = coverIds.filter((id) => !known.has(id)).map((id) => ({ id, is_active: false }));
  return expandWithCovers(ids, [...(people.data ?? []), ...covers, ...placeholders], now);
}

/**
 * Pure: reminder items (anything with `assigned_to`) duplicated for the active cover of the assignee,
 * so a per-person reminder plan also reaches the cover. Items without an owner are unchanged.
 */
export function expandReminderItems(items, profiles, now = new Date(), env = process.env) {
  if (!leaveCoverEnabled(env)) return items ?? [];
  const byId = new Map((profiles ?? []).filter((p) => p?.id).map((p) => [p.id, p]));
  const out = [];
  for (const item of items ?? []) {
    out.push(item);
    const cover = activeCoverId(byId.get(item?.assigned_to), now);
    if (!cover || cover === item.assigned_to) continue;
    const coverProfile = byId.get(cover);
    if (!coverProfile || coverProfile.is_active === false) continue;
    out.push({ ...item, assigned_to: cover, cover_for: item.assigned_to });
  }
  return out;
}
