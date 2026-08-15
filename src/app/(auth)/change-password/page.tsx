"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";

export default function ChangePasswordPage() {
  const { t } = useLanguage();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error(t("changePassword.mismatch"));
      return;
    }

    if (newPassword.length < 6) {
      toast.error(t("changePassword.tooShort"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.passwordChanged === true) {
          setOldPassword("");
          setNewPassword("");
          setConfirmPassword("");
          toast.error(data.error || "Password changed, but the security workflow did not complete.");
          window.location.href = "/login";
          return;
        }
        toast.error(data.error || t("changePassword.failed"));
        return;
      }

      toast.success(t("changePassword.success"));
      toast.info("Please log in again with your new password.");
      setTimeout(() => {
        window.location.href = "/login";
      }, 2000);
    } catch {
      toast.error(t("changePassword.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
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
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="oldPassword">{t("changePassword.current")}</Label>
              <Input
                id="oldPassword"
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder={t("changePassword.currentPlaceholder")}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">{t("changePassword.newPass")}</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t("changePassword.newPlaceholder")}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t("changePassword.confirm")}</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t("changePassword.confirmPlaceholder")}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t("changePassword.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
