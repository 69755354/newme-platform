"use client";

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { readSessionIdentity } from "@/lib/session-identity";

/**
 * useAuthRedirect — DashboardLayout 的鉴权 + 角色解析 + 重定向副作用集中点
 *
 * Uses server-side /api/auth/* endpoints instead of client-side Supabase.
 * This removes @supabase/supabase-js from the dashboard client bundle.
 *
 * Scenarios:
 *   1. Dev mode: POST /api/auth/dev-login → auto sign-in with fallback to /api/dev/setup
 *   2. Production: GET /api/auth/me → user + profile from session cookie
 *   3. 5s timeout: /api/auth/me 5s 仍未返回 → 显示连接错误（可重试），不跳登录页；答复到达后自动恢复
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

    // Production: fetch session from server.
    // A slow answer is not an invalid session. The timer used to push /login,
    // which logged a valid user out whenever Supabase was slow for 5 s; it now
    // shows the connection-error state (with its retry) and the read, which is
    // still in flight, fills the session in when it eventually answers.
    const t = setTimeout(() => {
      if (cancelled) return;
      setAuthError(true);
      setAuthLoading(false);
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
        setAuthError(false);
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
