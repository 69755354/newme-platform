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

/** Merge the four group results (arrays of rows, already ordered) into one list of at most `limit`, no lead twice, each row tagged. */
export function mergeInbox(groups, limit = INBOX_LIMIT) {
  const seen = new Set();
  const out = [];
  for (const name of INBOX_GROUPS) {
    for (const row of groups?.[name] ?? []) {
      if (out.length >= limit) return out;
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ ...row, inbox_group: name });
    }
  }
  return out;
}
