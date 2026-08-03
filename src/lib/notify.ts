/**
 * Narrow actor-event client. Callers await it; system events are intentionally
 * absent because only trusted business handlers may emit them.
 */

type NotifyParams =
  | { type: "lead_created"; lead_id: string }
  | { type: "quote_created"; quote_id: string };

export async function notify(params: NotifyParams): Promise<void> {
  const res = await fetch("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`notification_dispatch_failed:${res.status}`);
  }
}
