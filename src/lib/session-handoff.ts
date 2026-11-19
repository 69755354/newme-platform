/**
 * One-shot hand-over of the identity the dashboard layout has just read.
 *
 * The layout proves the session live (src/hooks/useAuthRedirect.ts) and only
 * then lets the page mount; the page's role guard used to prove it a second
 * time, one more full round trip. This lets the page that mounts right after
 * the layout's read use that read instead.
 *
 * It is deliberately not a cache: the value is taken once, by the first page
 * only, and expires after a few seconds, so a later navigation always proves
 * the session again and a revoked account is refused on its next page view.
 * Kept out of src/lib/session-identity.ts, the live reader, on purpose.
 */
export const SESSION_HANDOFF_TTL_MS = 3_000;

export interface SessionHandoff<T> {
  offer(identity: T): void;
  take(): T | null;
}

export function createSessionHandoff<T>(now: () => number = Date.now): SessionHandoff<T> {
  let held: { identity: T; at: number } | null = null;
  return {
    offer(identity) {
      held = { identity, at: now() };
    },
    take() {
      const current = held;
      held = null;
      if (!current || now() - current.at > SESSION_HANDOFF_TTL_MS) return null;
      return current.identity;
    },
  };
}
