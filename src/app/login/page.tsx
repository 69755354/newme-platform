"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LanguageProvider, useLanguage } from "@/lib/i18n/LanguageContext";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const COOKIE_NAMES = getSupabaseCookieNames(SUPABASE_URL);

function clearBrowserSession() {
  for (const name of [
    COOKIE_NAMES.authToken,
    COOKIE_NAMES.refreshToken,
    "sb-access-token",
    "sb-refresh-token",
  ]) {
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Strict; Secure`;
  }
}

async function revokeRejectedSession(accessToken: string) {
  try {
    await fetch("/api/auth/logout", {
      credentials: "same-origin",
      method: "POST",
    });
  } catch {
    // External revoke remains the fallback when same-origin cleanup fails.
  }

  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${accessToken}`,
      },
    });
  } catch {
    // The server-side profile gate still rejects the token if Auth logout fails.
  }

  clearBrowserSession();
}

function LoginPageInner() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          gotrue_meta_security: {},
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error_description || data.msg || t("login.failed"));
        setLoading(false);
        return;
      }

      // Let the same-origin server establish the controlled cookie session first.
      const sessionRes = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_in: data.expires_in,
        }),
      });
      if (!sessionRes.ok) {
        await revokeRejectedSession(data.access_token);
        throw new Error(t("login.failed"));
      }

      // Validate the cookie-backed session at the server boundary. Inactive
      // profiles are rejected before the user is allowed into the app.
      let activeCheck: Response;
      try {
        activeCheck = await fetch("/api/auth/me");
      } catch (error) {
        await revokeRejectedSession(data.access_token);
        throw error;
      }
      const activeData = await activeCheck.json().catch(() => null);
      if (!activeCheck.ok || activeData?.isActive !== true) {
        await revokeRejectedSession(data.access_token);
        setError(t("login.failed"));
        setLoading(false);
        return;
      }

      const redirectTo = searchParams.get("redirect") || "/dashboard";
      router.push(redirectTo);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("login.networkError"));
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-gold-500/20 bg-gray-950">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-gradient-to-br from-gold-500 to-gold-700 flex items-center justify-center font-bold text-black text-xl mb-3">
            N
          </div>
          <CardTitle className="text-white text-2xl">{t("login.title")}</CardTitle>
          <CardDescription className="text-gray-400">{t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-gray-300">{t("login.email")}</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@newme.ae"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="bg-gray-900 border-gray-700 text-white"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-gray-300">{t("login.password")}</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="bg-gray-900 border-gray-700 text-white"
              />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-gold-500 to-gold-600 text-black font-semibold hover:from-gold-400 hover:to-gold-500"
            >
              {loading ? t("login.signingIn") : t("login.signIn")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <LanguageProvider>
      <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><p className="text-white">Loading...</p></div>}>
        <LoginPageInner />
      </Suspense>
    </LanguageProvider>
  );
}
