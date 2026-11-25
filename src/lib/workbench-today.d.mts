export interface TodayTask {
  id: string;
  title: string;
  due_at: string;
  source?: string;
  lead_id?: string | null;
  lead_name?: string | null;
  overdue: boolean;
}
export interface TodayInboxRow {
  id: string;
  customer_name?: string | null;
  phone?: string | null;
  inbox_group?: string;
  next_followup_date?: string | null;
}
export function mergeTasksWithOverdue<T extends { id: string; due_at?: string | null }>(
  tasks: T[],
  overdue: T[],
  now?: Date,
): Array<T & { overdue: boolean }>;
export function todayThreeThings<T extends { id: string; due_at?: string | null; lead_id?: string | null; lead_name?: string | null }>(
  input: { inbox?: TodayInboxRow[]; tasks?: T[]; overdue?: T[] },
  now?: Date,
): {
  uncontactedNew: { count: number; items: TodayInboxRow[] };
  dueToday: { count: number; items: Array<T & { overdue: boolean }> };
  longestOverdue: (T & { overdue: boolean; customer_name: string | null; phone: string | null }) | null;
};
