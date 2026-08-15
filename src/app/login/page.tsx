"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LanguageProvider, useLanguage } from "@/lib/i18n/LanguageContext";
import { safeRedirectPath } from "@/lib/safe-redirect";

/**
 * Sign-in is a single same-origin request to POST /api/auth/login.
 *
 * It used to be three serial round trips from the browser: a password grant sent
 * straight to Supabase Auth (leaving the CDN edge and paying a cold TLS
 * handshake to the Auth region), then /api/auth/session to exchange the tokens
 * for cookies, then /api/auth/me to check the profile was active. The server now
 * does all three over warm origin-to-Supabase connections, so the browser pays
 * one round trip on a connection it already has open.
 *
 * The browser therefore never handles a raw token, and a rejected profile never
 * receives a cookie at all: the server revokes its token before responding.
 */

function LoginPageInner() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();

  function messageFor(code: unknown): string {
    switch (code) {
      case "rate_limited":
        return t("login.rateLimited");
      case "inactive_account":
        return t("login.inactiveAccount");
      case "auth_unavailable":
        return t("login.unavailable");
      default:
        // Never distinguish a wrong password from an unknown address.
        return t("login.failed");
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || data?.ok !== true || data?.isActive !== true) {
        setError(messageFor(data?.error));
        setLoading(false);
        return;
      }

      // Same-origin paths only. `redirect` is attacker-supplied, and an open
      // redirect on the sign-in page hands a freshly authenticated user to a
      // credential-harvesting page on the strength of our own domain.
      router.push(safeRedirectPath(searchParams.get("redirect")));
      router.refresh();
    } catch {
      setError(t("login.networkError"));
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
                autoComplete="username"
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
                autoComplete="current-password"
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
