"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser } from "@/app/actions/auth";

const MANAGEMENT_ROLES = ["admin", "boss", "operator"];

/**
 * Client-side role guard. Redirects to /dashboard if user lacks required role.
 * Returns { loading, role, blocked } so the page can block rendering.
 *
 * Uses server action (getCurrentUser) — no client-side Supabase dependency.
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
      try {
        const user = await getCurrentUser();

        if (!user) {
          router.push("/login");
          return;
        }

        if (cancelled) return;

        const userRole = user.role ?? null;
        setRole(userRole);
        setLoading(false);

        if (!userRole || !rolesRef.current.includes(userRole)) {
          setBlocked(true);
          router.push("/dashboard");
        }
      } catch {
        if (!cancelled) {
          router.push("/login");
        }
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
