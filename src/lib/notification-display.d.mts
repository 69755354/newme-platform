export function localizeNotification(
  notification: { title?: string | null; body?: string | null } | null | undefined,
  t: (key: string) => string,
): { title: string | null; body: string | null };
