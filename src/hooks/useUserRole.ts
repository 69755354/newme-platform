"use client";

import { useContext, useState, useEffect } from "react";
import { readSessionIdentity, type SessionOutcome } from "@/lib/session-identity";
import { PageIdentityContext, SessionHandoffContext } from "@/lib/session-contexts";

export interface UserRoleInfo {
  role: string | null;
  userId: string | null;
  isCEO: boolean;   // admin, boss, operator — full data access
  isSales: boolean;  // sales — only own data
  loading: boolean;
}

/**
 * Reads GET /api/auth/me through the shared session reader rather than the
 * getCurrentUser() server action: action ids change with every release, so a
 * tab opened before a deploy silently got role = null and managers saw the
 * restricted or empty version of every page until they refreshed by hand.
 * While the answer is unavailable (timeout, 5xx) `loading` stays true so a
 * manager is never rendered as a restricted user; the layout shows its
 * connection-error state from the same in-flight read.
 */
export function useUserRole(): UserRoleInfo {
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageIdentity = useContext(PageIdentityContext);
  const handoff = useContext(SessionHandoffContext);

  useEffect(() => {
    // A page above already resolved the identity: nothing to ask (S22).
    if (pageIdentity) return;
    let cancelled = false;
    (async () => {
      const handed = handoff?.take() ?? null;
      const outcome: SessionOutcome = handed
        ? { status: "active", identity: handed }
        : await readSessionIdentity();
      if (cancelled) return;
      if (outcome.status === "unavailable") return;
      if (outcome.status === "active") {
        setUserId(outcome.identity.userId);
        setRole(outcome.identity.role || "sales");
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (pageIdentity) {
    const inheritedRole = pageIdentity.role || "sales";
    return {
      role: inheritedRole,
      userId: pageIdentity.userId,
      isCEO: inheritedRole === "admin" || inheritedRole === "boss" || inheritedRole === "operator",
      isSales: inheritedRole === "sales",
      loading: false,
    };
  }

  return {
    role,
    userId,
    isCEO: role === "admin" || role === "boss" || role === "operator",
    isSales: role === "sales",
    loading,
  };
}
