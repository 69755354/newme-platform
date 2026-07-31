"use client";

import { ShieldAlert } from "lucide-react";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { useLanguage } from "@/lib/i18n/LanguageContext";

export default function AccessNotConfiguredPage() {
  const { t } = useLanguage();

  return (
    <DashboardScrollContainer className="flex h-full items-center justify-center">
      <section className="max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <ShieldAlert className="mx-auto h-9 w-9 text-amber-500" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-semibold text-foreground">
          {t("common.accessNotConfiguredTitle")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("common.accessNotConfiguredDescription")}
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          {t("common.accessNotConfiguredContactAdmin")}
        </p>
      </section>
    </DashboardScrollContainer>
  );
}
