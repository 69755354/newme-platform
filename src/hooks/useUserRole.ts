"use client";

import { useState, useEffect } from "react";
import { getCurrentUser } from "@/controllers/actions/auth";

export interface UserRoleInfo {
  role: string | null;
  userId: string | null;
  isCEO: boolean;   // admin, boss, operator — full data access
  isSales: boolean;  // sales — only own data
  loading: boolean;
}

export function useUserRole(): UserRoleInfo {
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await getCurrentUser();
        if (!user) {
          if (!cancelled) setLoading(false);
          return;
        }
        if (cancelled) return;
        setUserId(user.id);
        const r = user.role ?? "sales";
        setRole(r);
      } catch {
        // silent
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return {
    role,
    userId,
    isCEO: role === "admin" || role === "boss" || role === "operator",
    isSales: role === "sales",
    loading,
  };
}
