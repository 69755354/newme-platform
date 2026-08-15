"use client";

/**
 * Shared client-side reader for GET /api/auth/me.
 *
 * Two independent consumers used to fetch this endpoint on every dashboard
 * mount: the authorization gate and analytics identification. That was two
 * identical round trips, each costing a session validation and a profiles read.
 *
 * The split below is deliberate. The authorization path always performs a live
 * read, because re-proving that the profile is still active on every mount is
 * the session revocation boundary; caching it would create a window where a
 * disabled account keeps working. Analytics is not an authorization decision, so
 * it may reuse the most recent live result instead of issuing its own request.
 */

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

const ANALYTICS_REUSE_MS = 60_000;

let inflight: Promise<SessionOutcome> | null = null;
let lastActive: { identity: SessionIdentity; at: number } | null = null;

async function request(): Promise<SessionOutcome> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (response.status === 401 || response.status === 403) {
    return { status: "unauthenticated" };
  }
  if (!response.ok) return { status: "unavailable" };

  const body = (await response.json()) as SessionIdentity | undefined;
  if (!body || body.isActive !== true) return { status: "unauthenticated" };

  lastActive = { identity: body, at: Date.now() };
  return { status: "active", identity: body };
}

/**
 * Live session read for the authorization gate. Concurrent callers share one
 * request, but the result is never served from a cache.
 */
export async function readSessionIdentity(): Promise<SessionOutcome> {
  if (inflight) return inflight;
  inflight = request()
    .catch((): SessionOutcome => ({ status: "unavailable" }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Best-effort identity for consumers that do not gate access on it. Reuses a
 * recent live read or joins one in flight rather than adding a round trip.
 * Never use this to decide what a user may see or do.
 */
export async function peekSessionIdentity(): Promise<SessionIdentity | null> {
  if (lastActive && Date.now() - lastActive.at < ANALYTICS_REUSE_MS) {
    return lastActive.identity;
  }
  if (inflight) {
    const outcome = await inflight;
    return outcome.status === "active" ? outcome.identity : null;
  }
  const outcome = await readSessionIdentity();
  return outcome.status === "active" ? outcome.identity : null;
}

/** Drop reusable state. Called on sign-out so no identity outlives its session. */
export function forgetSessionIdentity(): void {
  lastActive = null;
}
