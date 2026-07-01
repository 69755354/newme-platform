"use client";

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient, ensureSession } from "@/lib/supabase";

/**
 * useAuthRedirect — DashboardLayout 的鉴权 + 角色解析 + 重定向副作用集中点
 *
 * 负责 4 个场景:
 *   1. Dev mode (`NEXT_PUBLIC_DEV_MODE=true`): 调用 signInWithPassword 自动登录 dev 账号;
 *      失败时调用 /api/dev/setup 兜底创建用户,然后重试 sign-in。session 由
 *      createBrowserClient (@supabase/ssr) 自行写入 cookie,这里只更新 React state。
 *   2. Production: supabase.auth.getUser() 拿当前 user,再查 profiles.role + force_password_change;
 *      若 force_password_change=true 且不在 /change-password 则跳转。
 *   3. 5s 超时: getUser 5s 仍未返回 → 推 /login (避免白屏卡死)。
 *   4. Sales user 命中 /dashboard 路径 → replace 到 /workbench (sales 默认首页)。
 *
 * 同时暴露 handleLogout: signOut + 清理 localStorage auth-token + 清理 4 个 chunked cookie
 * (sb-vfopmpxlhwzpxqegayew-auth-token / -refresh-token / sb-access-token / sb-refresh-token) + push /login。
 *
 * @returns {userId, role, userEmail, authLoading, authError, handleLogout}
 */
export function useAuthRedirect() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Dev mode — auto sign-in to get valid JWT so RLS passes (production-safe: NODE_ENV guard)
    if (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_MODE === "true") {
      const DEV_EMAIL = process.env.DEV_EMAIL || "dev@newme.ae";
      const DEV_PASSWORD = process.env.DEV_PASSWORD || "dev123456";

      async function devLogin() {
        const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
          email: DEV_EMAIL,
          password: DEV_PASSWORD,
        });

        if (signInErr || !signInData.session) {
          // User missing or email not confirmed — call setup endpoint
          try {
            await fetch("/api/dev/setup", { method: "POST" });
            // Retry sign in after setup
            const { data: retryData, error: retryErr } = await supabase.auth.signInWithPassword({
              email: DEV_EMAIL,
              password: DEV_PASSWORD,
            });
            if (retryErr || !retryData.session) {
              if (cancelled) return;
              setAuthError(true);
              setAuthLoading(false);
              return;
            }
            if (cancelled) return;
            setUserId(retryData.session.user?.id ?? null);
            storeSession(retryData.session);
            return;
          } catch {
            if (cancelled) return;
            setAuthError(true);
            setAuthLoading(false);
            return;
          }
        }
        if (cancelled) return;
        setUserId(signInData.session.user?.id ?? null);
        storeSession(signInData.session);
      }

      function storeSession(_session: unknown) {
        // createBrowserClient (@supabase/ssr) manages the auth cookie itself
        // after signInWithPassword. We only update React state here — no manual
        // localStorage / document.cookie writes (those conflicted with the ssr
        // chunked-cookie refresh and caused intermittent session loss).
        void _session;
        setUserEmail(DEV_EMAIL);
        setRole("admin");
        setAuthLoading(false);
      }

      devLogin();
      return;
    }

    const t = setTimeout(() => {
      if (!cancelled) router.push("/login");
    }, 5000);
    ensureSession().then(() => supabase.auth.getUser()).then(({ data: { user }, error }) => {
      clearTimeout(t);
      if (cancelled) return;
      if (error || !user) { router.push("/login"); return; }
      setUserId(user.id);
      setUserEmail(user.email ?? null);
      supabase.from("profiles").select("role, force_password_change, full_name").eq("id", user.id).single()
        .then(({ data, error: profileErr }) => {
          if (cancelled) return;
          if (profileErr) {
            // No profile row → fallback to sales (defensive; RLS may hide row)
            setRole("sales");
            setAuthLoading(false);
            return;
          }
          const r = data?.role ?? "sales";
          setRole(r);
          if (data?.force_password_change && pathname !== "/change-password") {
            router.push("/change-password");
          }
          setAuthLoading(false);
        });
    }).catch(() => {
      clearTimeout(t);
      if (!cancelled) { setAuthError(true); setAuthLoading(false); }
    });
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redirect sales users from /dashboard to /workbench (default sales homepage)
  useEffect(() => {
    if (!role) return;
    const isMgmt = role === "admin" || role === "boss" || role === "operator";
    if (!isMgmt && pathname === "/dashboard") {
      router.replace("/workbench");
    }
  }, [role, pathname, router]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    // Clear all auth storage from login page
    localStorage.removeItem("sb-vfopmpxlhwzpxqegayew-auth-token");
    const clearCookie = (name: string) => {
      document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
    };
    clearCookie("sb-vfopmpxlhwzpxqegayew-auth-token");
    clearCookie("sb-vfopmpxlhwzpxqegayew-refresh-token");
    clearCookie("sb-access-token");
    clearCookie("sb-refresh-token");
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