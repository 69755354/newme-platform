"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LanguageToggle } from "@/components/LanguageToggle";
import { readSessionIdentity } from "@/lib/session-identity";
import { AlertCircle, CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import {
  passwordChangeMessageKey,
  validatePasswordChange,
} from "@/lib/password-change-validation.mjs";

/**
 * Forced / self-service password change.
 *
 * S6 (review 4d #2/#3): this page used to call toast(), but the (auth) layout
 * mounts no Toaster, so every outcome was silent and success bounced to
 * /login after a timer. Feedback is now inline (role="alert" / role="status"),
 * the user stays on the page with their input on every error, and the same
 * rules as the API (including "new must differ from current") run first.
 *
 * Success: the API revokes every session of this account, the current one
 * included (security requirement — see the route). So the page signs straight
 * back in with the new password and continues into the app. Only if that
 * sign-in is impossible does it say plainly that a re-login is required and
 * offer a button, instead of a surprise logout.
 */

type Feedback =
  | { kind: "error"; key: string }
  | { kind: "success"; key: string }
  | { kind: "relogin"; key: string };

export default function ChangePasswordPage() {
  const { t } = useLanguage();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  // The session is revoked by a successful change, so learn the sign-in
  // address while the session is still valid. /api/auth/me is one of the
  // endpoints a forced session may reach.
  useEffect(() => {
    let cancelled = false;
    readSessionIdentity()
      .then((outcome) => {
        if (!cancelled && outcome.status === "active" && typeof outcome.identity.email === "string") {
          setEmail(outcome.identity.email);
        }
      })
      .catch(() => { /* re-login fallback covers this */ });
    return () => { cancelled = true; };
  }, []);

  async function continueWithNewPassword(password: string): Promise<boolean> {
    if (!email) return false;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => null);
      return res.ok && data?.ok === true && data?.isActive === true && data?.forcePasswordChange !== true;
    } catch {
      return false;
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setFeedback(null);

    const invalid = validatePasswordChange({ oldPassword, newPassword, confirmPassword });
    if (invalid) {
      setFeedback({ kind: "error", key: passwordChangeMessageKey(invalid) });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data?.passwordChanged === true) {
          // The password did change; only a follow-up security step failed.
          // Never leave the old password in the form, and say what happened.
          setOldPassword("");
          setNewPassword("");
          setConfirmPassword("");
          setFeedback({ kind: "relogin", key: passwordChangeMessageKey("partial_success") });
          return;
        }
        const code = typeof data?.code === "string"
          ? data.code
          : res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : "update_failed";
        // Keep everything the user typed so they can correct one field.
        setFeedback({ kind: "error", key: passwordChangeMessageKey(code) });
        return;
      }

      const password = newPassword;
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setFeedback({ kind: "success", key: "changePassword.successContinuing" });
      if (await continueWithNewPassword(password)) {
        window.location.assign("/dashboard");
        return;
      }
      setFeedback({ kind: "relogin", key: "changePassword.reloginRequired" });
    } catch {
      setFeedback({ kind: "error", key: passwordChangeMessageKey("network") });
    } finally {
      setLoading(false);
    }
  };

  const done = feedback?.kind === "success" || feedback?.kind === "relogin";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <Card className="w-full max-w-md border-border/15">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">{t("changePassword.title")}</CardTitle>
          <CardDescription>
            {t("changePassword.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {feedback?.kind === "error" && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t(feedback.key)}</span>
            </div>
          )}
          {done && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t(feedback.key)}</span>
            </div>
          )}
          {feedback?.kind === "relogin" ? (
            <Button className="w-full" onClick={() => window.location.assign("/login")}>
              {t("changePassword.goToLogin")}
            </Button>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="oldPassword">{t("changePassword.current")}</Label>
                <Input
                  id="oldPassword"
                  type="password"
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  placeholder={t("changePassword.currentPlaceholder")}
                  disabled={done}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">{t("changePassword.newPass")}</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t("changePassword.newPlaceholder")}
                  disabled={done}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t("changePassword.confirm")}</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t("changePassword.confirmPlaceholder")}
                  disabled={done}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading || done}>
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {loading ? t("common.saving") : t("changePassword.submit")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
