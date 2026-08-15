/**
 * Client-side helper to trigger notifications via /api/notify.
 * Called after business actions complete (assign lead, stage change, etc.).
 * Callers decide whether a notification failure is fatal to their UI flow.
 * This helper never converts a failed request into a resolved promise.
 */

import type { NotificationType } from "./notifications";

export type NotifyParams = { type: NotificationType } & Record<string, unknown>;

export async function notify(params: NotifyParams): Promise<void> {
  const res = await fetch("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    const code = typeof errorBody.code === "string"
      ? errorBody.code
      : typeof errorBody.error === "string"
        ? errorBody.error
        : "unknown";
    throw new Error(`notification_request_failed:${res.status}:${code}`);
  }
}
