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

let inflight: Promise<SessionOutcome> | null = null;

async function request(): Promise<SessionOutcome> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (response.status === 401 || response.status === 403) {
    return { status: "unauthenticated" };
  }
  if (!response.ok) return { status: "unavailable" };

  const body = (await response.json()) as SessionIdentity | undefined;
  if (!body || body.isActive !== true) return { status: "unauthenticated" };

  return { status: "active", identity: body };
}

/**
 * Live session read for the authorization gate. Concurrent callers share one
 * in-flight request, but no result is ever served from a cache.
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
