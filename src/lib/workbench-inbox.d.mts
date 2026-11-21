export const INBOX_LIMIT: number;
export type InboxGroup = "new" | "due_today" | "overdue" | "later";
export const INBOX_GROUPS: readonly InboxGroup[];
export function inboxDayKeys(now?: Date): { today: string; tomorrow: string };
export function mergeInbox<T extends { id: string }>(groups: Partial<Record<InboxGroup, T[]>>, limit?: number): Array<T & { inbox_group: InboxGroup }>;
