// Sales workbench inbox (S35 B7). The old inbox sorted by next follow-up date and cut at 20, so a handful of old overdue
// leads pushed a freshly assigned, never-contacted lead out of the list. The inbox now fills in this order, each group
// read by its own query so one group can never crowd out another's candidates:
//   1. new         never contacted (stage still "new", no contact date): newest assignment / update first
//   2. due_today   next follow-up is today (Dubai)
//   3. overdue     next follow-up is before today (Dubai), the longest-waiting first
//   4. later       no date or a future date
import { addDaysToDateKey, dubaiDateKey } from "./dubai-time.mjs";

export const INBOX_LIMIT = 20;
export const INBOX_GROUPS = Object.freeze(["new", "due_today", "overdue", "later"]);

/** Dubai calendar keys the group queries compare against. */
export function inboxDayKeys(now = new Date()) {
  const today = dubaiDateKey(now);
  return { today, tomorrow: addDaysToDateKey(today, 1) };
}

export const INBOX_NEW_CAP = 8;

/**
 * Merge the four group results (arrays of rows, already ordered) into one list of at most `limit`, no lead twice, each row
 * tagged. "New" is capped at INBOX_NEW_CAP so a burst of new leads cannot hide today's and overdue follow-ups; the other
 * groups fill the rest in order, and any slack (a group with fewer rows) goes back to more new leads. Output order is
 * always new, due_today, overdue, later.
 */
export function mergeInbox(groups, limit = INBOX_LIMIT, newCap = INBOX_NEW_CAP) {
  const seen = new Set();
  const lists = {};
  for (const name of INBOX_GROUPS) {
    lists[name] = [];
    for (const row of groups?.[name] ?? []) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      lists[name].push({ ...row, inbox_group: name });
    }
  }
  const taken = { new: Math.min(lists.new.length, newCap, limit) };
  let room = limit - taken.new;
  for (const name of INBOX_GROUPS.slice(1)) {
    taken[name] = Math.min(lists[name].length, room);
    room -= taken[name];
  }
  taken.new = Math.min(lists.new.length, taken.new + room); // slack goes back to new leads
  return INBOX_GROUPS.flatMap((name) => lists[name].slice(0, taken[name]));
}
