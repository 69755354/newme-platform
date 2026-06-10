"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase";

export interface UserRoleInfo {
  role: string | null;
  userId: string | null;
  isCEO: boolean;   // admin, boss, operator — full data access
  isSales: boolean;  // sales — only own data
  loading: boolean;
}

export function useUserRole(): UserRoleInfo {
  const supabase = createClient();
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user) {
        if (!cancelled) setLoading(false);
        return;
      }
      if (cancelled) return;
      setUserId(user.id);

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!cancelled) {
        const r = profile?.role ?? "sales";
        setRole(r);
        setLoading(false);
      }
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
