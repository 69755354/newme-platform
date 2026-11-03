"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { readSessionIdentity } from "@/lib/session-identity";

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
 */
export function useRequireRole(allowedRoles: string[] = MANAGEMENT_ROLES) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [role, setRole] = useState<string | null>(null);

  // Stabilize array reference to prevent infinite re-renders
  const rolesRef = useRef(allowedRoles);
  const rolesKey = JSON.stringify(allowedRoles);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const outcome = await readSessionIdentity();
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

  return { loading, role, blocked, unavailable };
}
