"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";

const MANAGEMENT_ROLES = ["admin", "boss", "operator"];

/**
 * Client-side role guard. Redirects to /dashboard if user lacks required role.
 * Returns { loading, role, blocked } so the page can block rendering.
 */
export function useRequireRole(allowedRoles: string[] = MANAGEMENT_ROLES) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [role, setRole] = useState<string | null>(null);

  // Stabilize array reference to prevent infinite re-renders
  const rolesRef = useRef(allowedRoles);
  const rolesKey = JSON.stringify(allowedRoles);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (cancelled) return;

      const userRole = profile?.role ?? null;
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

  return { loading, role, blocked };
}
