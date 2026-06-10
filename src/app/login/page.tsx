"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LanguageProvider, useLanguage } from "@/lib/i18n/LanguageContext";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function LoginPageInner() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { t } = useLanguage();
  const router = useRouter();

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

      // Store session in localStorage for client-side createClient()
      localStorage.setItem("sb-vfopmpxlhwzpxqegayew-auth-token", JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        user: data.user,
      }));

      // @supabase/ssr middleware uses default cookieEncoding="raw" — plain JSON, no base64
      // Base64-encode the session payload to obscure tokens
      const encodedPayload = btoa(JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
      }));

      // Primary format for @supabase/ssr (createServerClient / middleware)
      document.cookie = `sb-vfopmpxlhwzpxqegayew-auth-token=${encodedPayload}; path=/; max-age=${data.expires_in}; SameSite=Strict; Secure`;
      document.cookie = `sb-vfopmpxlhwzpxqegayew-refresh-token=${data.refresh_token}; path=/; max-age=2592000; SameSite=Strict; Secure`;
      // Legacy format for backward compat (middleware fallback)
      document.cookie = `sb-access-token=${data.access_token}; path=/; max-age=${data.expires_in}; SameSite=Strict; Secure`;
      document.cookie = `sb-refresh-token=${data.refresh_token}; path=/; max-age=2592000; SameSite=Strict; Secure`;

      router.push("/dashboard");
      router.refresh();
    } catch (err: any) {
      setError(err.message || t("login.networkError"));
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
      <LoginPageInner />
    </LanguageProvider>
  );
}
