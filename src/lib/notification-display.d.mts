export function localizeNotification(
  notification: { title?: string | null; body?: string | null } | null | undefined,
  t: (key: string) => string,
): { title: string | null; body: string | null };

// S41
export const SALES_HIDDEN_NOTIFICATION_TYPES: readonly string[];
export const SALES_VISIBLE_NOTIFICATION_TYPES: readonly string[];
export function notificationTypesForRole(role: string | null | undefined): string[] | null;
