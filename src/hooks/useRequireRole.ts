"use client";

import { useContext, useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { readSessionIdentity, type SessionOutcome } from "@/lib/session-identity";
import { PageIdentityContext, SessionHandoffContext } from "@/lib/session-contexts";
import { identityFromPage } from "@/lib/page-identity";

const MANAGEMENT_ROLES = ["admin", "boss", "operator"];

/**
 * Client-side role guard. Redirects to /dashboard if user lacks required role.
 * Returns { loading, role, blocked, unavailable } so the page can block rendering.
 *
 * Reads GET /api/auth/me through the shared session reader. This used to call
 * the getCurrentUser() server action, whose id changes with every release: a
 * tab opened before a deploy got "Server Reference ID did not match", the
 * catch branch pushed /login, and every manager was logged out by the release.
 * A route handler keeps its URL across releases, and a stale tab is reloaded
 * once by src/lib/session-identity.ts instead of being sent to /login.
 *
 * Only a real refusal (401/403, inactive profile) goes to /login. An
 * unavailable answer (timeout, 5xx, after the reader's own retries) sets
 * `unavailable` and publishes it through the session reader's shared
 * "unavailable" state, which the dashboard layout renders as the common
 * "connection failed · retry" view in place of the page.
 *
 * Speed (S22): the identity is looked for in this order -- the page above
 * already resolved it (PageIdentityContext, no request); the layout read it a
 * moment ago and hands it to the first page (SessionHandoffContext, no
 * request); otherwise a live read as before. See src/lib/session-handoff.ts.
 */
export function useRequireRole(allowedRoles: string[] = MANAGEMENT_ROLES) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const pageIdentity = useContext(PageIdentityContext);
  const handoff = useContext(SessionHandoffContext);

  // Stabilize array reference to prevent infinite re-renders
  const rolesRef = useRef(allowedRoles);
  const rolesKey = JSON.stringify(allowedRoles);

  useEffect(() => {
    if (pageIdentity) return;
    let cancelled = false;

    async function check() {
      const handed = handoff?.take() ?? null;
      const outcome: SessionOutcome = handed
        ? { status: "active", identity: handed }
        : await readSessionIdentity();
      if (cancelled) return;

      if (outcome.status === "unauthenticated") {
        router.push("/login");
        return;
      }
      if (outcome.status === "unavailable") {
        setUnavailable(true);
        return;
      }

      const userRole = outcome.identity.role ?? null;
      setRole(userRole);
      setUserId(outcome.identity.userId ?? null);
      setLoading(false);

      if (!userRole || !rolesRef.current.includes(userRole)) {
        setBlocked(true);
        router.push("/dashboard");
      }
    }

    check();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolesKey, router]);

  const inherited = identityFromPage(pageIdentity, allowedRoles);
  if (inherited) {
    return { loading: false, role: inherited.role, userId: inherited.userId, blocked: inherited.blocked, unavailable: false };
  }
  return { loading, role, userId, blocked, unavailable };
}
