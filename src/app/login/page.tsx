"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LanguageProvider, useLanguage } from "@/lib/i18n/LanguageContext";
import { createClient } from "@/lib/supabase";

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
      const supabase = createClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError || !data.session) {
        setError(signInError?.message || t("login.failed"));
        setLoading(false);
        return;
      }

      // createBrowserClient (@supabase/ssr) writes the auth cookie itself
      // (chunked + base64url). No manual localStorage / document.cookie writes.
      const redirectTo = searchParams.get("redirect") || "/dashboard";
      router.push(redirectTo);
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
      <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><p className="text-white">Loading...</p></div>}>
        <LoginPageInner />
      </Suspense>
    </LanguageProvider>
  );
}
