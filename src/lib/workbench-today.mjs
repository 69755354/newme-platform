// S41 (recheck §2-5, F04): the sales workbench on a phone. Tasks and Overdue were two cards (the same task could sit in
// both); they are one list now, overdue first and marked. "Today's 3 things" is derived from the data the page already
// holds: new leads not yet contacted, tasks due today (Dubai), and the longest-overdue task.
import { dubaiDateKey } from "./dubai-time.mjs";

/**
 * One task list: every overdue task first (oldest first), then the rest by due date, no task twice.
 * Each row gains `overdue: boolean`.
 */
export function mergeTasksWithOverdue(tasks = [], overdue = [], now = new Date()) {
  const nowMs = now.getTime();
  const seen = new Set();
  const out = [];
  const push = (task, flag) => {
    if (!task?.id || seen.has(task.id)) return;
    seen.add(task.id);
    out.push({ ...task, overdue: flag });
  };
  const dueMs = (task) => {
    const ms = task?.due_at ? new Date(task.due_at).getTime() : NaN;
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  };
  for (const task of [...overdue].sort((a, b) => dueMs(a) - dueMs(b))) push(task, true);
  for (const task of [...tasks].sort((a, b) => dueMs(a) - dueMs(b))) push(task, dueMs(task) < nowMs);
  // A task from `tasks` that is already past due sorts with the overdue block.
  return out.sort((a, b) => (a.overdue === b.overdue ? dueMs(a) - dueMs(b) : a.overdue ? -1 : 1));
}

/**
 * @returns {{ uncontactedNew: { count: number, items: object[] }, dueToday: { count: number, items: object[] }, longestOverdue: object | null }}
 */
export function todayThreeThings({ inbox = [], tasks = [], overdue = [] } = {}, now = new Date()) {
  const today = dubaiDateKey(now);
  const newItems = inbox.filter((lead) => lead?.inbox_group === "new");
  const merged = mergeTasksWithOverdue(tasks, overdue, now);
  const dueTodayItems = merged.filter((task) => task.due_at && dubaiDateKey(task.due_at) === today);
  const first = merged.find((task) => task.overdue) ?? null;
  let longestOverdue = null;
  if (first) {
    const lead = inbox.find((row) => row?.id && row.id === first.lead_id) ?? null;
    longestOverdue = {
      ...first,
      customer_name: lead?.customer_name ?? first.lead_name ?? null,
      phone: lead?.phone ?? null,
    };
  }
  return {
    uncontactedNew: { count: newItems.length, items: newItems },
    dueToday: { count: dueTodayItems.length, items: dueTodayItems },
    longestOverdue,
  };
}
