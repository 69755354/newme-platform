"use client";

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { forgetSessionIdentity, readSessionIdentity } from "@/lib/session-identity";

/**
 * useAuthRedirect — DashboardLayout 的鉴权 + 角色解析 + 重定向副作用集中点
 *
 * Uses server-side /api/auth/* endpoints instead of client-side Supabase.
 * This removes @supabase/supabase-js from the dashboard client bundle.
 *
 * Scenarios:
 *   1. Dev mode: POST /api/auth/dev-login → auto sign-in with fallback to /api/dev/setup
 *   2. Production: GET /api/auth/me → user + profile from session cookie
 *   3. 5s timeout: /api/auth/me 5s 仍未返回 → push /login
 *   4. Sales user on /dashboard → replace to /workbench
 *
 * handleLogout: POST /api/auth/logout clears the server-owned session cookies, then pushes /login
 */
export function useAuthRedirect() {
  const pathname = usePathname();
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Dev mode — auto sign-in via server endpoint
    if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DEV_MODE === "true") {
      async function devLogin() {
        try {
          const res = await fetch("/api/auth/dev-login", { method: "POST" });
          if (res.ok) {
            const data = await res.json();
            if (cancelled) return;
            setUserId(data.userId);
            setUserEmail(data.email);
            setRole(data.role || "admin");
            setAuthLoading(false);
          } else {
            if (cancelled) return;
            setAuthError(true);
            setAuthLoading(false);
          }
        } catch {
          if (cancelled) return;
          setAuthError(true);
          setAuthLoading(false);
        }
      }
      devLogin();
      return;
    }

    // Production: fetch session from server
    const t = setTimeout(() => {
      if (!cancelled) router.push("/login");
    }, 5000);

    // Always a live read: this is the session revocation boundary, so a
    // deactivated profile must be rejected on the very next mount.
    readSessionIdentity()
      .then((outcome) => {
        clearTimeout(t);
        if (cancelled) return;
        if (outcome.status === "unauthenticated") {
          router.push("/login");
          return;
        }
        if (outcome.status === "unavailable") {
          setAuthError(true);
          setAuthLoading(false);
          return;
        }
        const data = outcome.identity;
        setUserId(data.userId);
        setUserEmail(data.email);
        const r = data.role || "sales";
        setRole(r);
        if (data.forcePasswordChange && pathname !== "/change-password") {
          router.push("/change-password");
        }
        setAuthLoading(false);
      })
      .catch(() => {
        clearTimeout(t);
        if (!cancelled) {
          setAuthError(true);
          setAuthLoading(false);
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redirect sales users from /dashboard to /workbench
  useEffect(() => {
    if (!role) return;
    const isMgmt = role === "admin" || role === "boss" || role === "operator";
    if (!isMgmt && pathname === "/dashboard") {
      router.replace("/workbench");
    }
  }, [role, pathname, router]);

  const handleLogout = async () => {
    forgetSessionIdentity();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // proceed to clear local state even if server call fails
    }
    router.push("/login");
  };

  return {
    userId,
    role,
    userEmail,
    authLoading,
    authError,
    handleLogout,
  };
}
