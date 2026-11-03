"use client";

/**
 * Shared client-side reader for GET /api/auth/me.
 *
 * This read is always live. Re-proving that the profile is still active on every
 * mount is the session revocation boundary, so a cached verdict would leave a
 * window in which a disabled account keeps working.
 *
 * The module also exposed a second, cached reader for analytics identification.
 * The client-side analytics integration is gone, so the cache went with it: an
 * unused identity cache in module scope is a copy of the user's email and role
 * kept alive for nobody. Do not name the removed function here -- the revocation
 * test forbids its identifier anywhere in this file, comments included.
 *
 * An unavailable answer (timeout, 5xx, network failure) is retried a bounded
 * number of times before it is reported, and the final "unavailable" verdict is
 * published to the dashboard layout, which renders the shared
 * "connection failed · retry" view in place of the page. Pages never go to
 * /login for an unavailable answer and never stay on "loading" for ever.
 */

// Relative on purpose: tests/security/session-revocation.test.mjs loads this
// file with a loader that resolves relative paths but not the "@/" alias.
import { reloadIfServerReleaseDiffers } from "./deployment-skew.mjs";

export type SessionIdentity = {
  userId: string | null;
  email: string | null;
  role: string;
  isActive: boolean;
  forcePasswordChange: boolean;
  fullName: string | null;
};

export type SessionOutcome =
  | { status: "active"; identity: SessionIdentity }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/** Back-off between attempts when the answer is unavailable: 1 s, then 3 s. */
export const SESSION_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

let inflight: Promise<SessionOutcome> | null = null;

async function request(): Promise<SessionOutcome> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  // A tab from a previous release gets a valid answer here (route handlers
  // keep their URL across releases), but its bundle will fail the next server
  // action. Reload once now, while nothing is in flight; the outcome below is
  // still returned so the current render stays consistent until then.
  if (typeof response.headers?.get === "function") reloadIfServerReleaseDiffers(response.headers);
  if (response.status === 401 || response.status === 403) {
    return { status: "unauthenticated" };
  }
  if (!response.ok) return { status: "unavailable" };

  const body = (await response.json()) as SessionIdentity | undefined;
  if (!body || body.isActive !== true) return { status: "unauthenticated" };

  return { status: "active", identity: body };
}

const attempt = (): Promise<SessionOutcome> =>
  request().catch((): SessionOutcome => ({ status: "unavailable" }));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── shared "unavailable" state, read by the dashboard layout ────────────────
let unavailable = false;
const listeners = new Set<() => void>();

function publishUnavailable(next: boolean) {
  if (unavailable === next) return;
  unavailable = next;
  for (const listener of listeners) listener();
}

/** useSyncExternalStore-compatible subscription to the shared state. */
export function subscribeSessionUnavailable(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True while the last completed session read ended unavailable. */
export function isSessionUnavailable(): boolean {
  return unavailable;
}

/**
 * Live session read for the authorization gate. Concurrent callers share one
 * in-flight request, but no result is ever served from a cache.
 */
export async function readSessionIdentity(
  options: { retryDelaysMs?: readonly number[] } = {},
): Promise<SessionOutcome> {
  if (inflight) return inflight;
  const delays = options.retryDelaysMs ?? SESSION_RETRY_DELAYS_MS;
  inflight = (async () => {
    let outcome = await attempt();
    for (const delay of delays) {
      if (outcome.status !== "unavailable") break;
      await sleep(delay);
      outcome = await attempt();
    }
    publishUnavailable(outcome.status === "unavailable");
    return outcome;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
