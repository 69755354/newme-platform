"use client";

import { useLanguage } from "@/views/i18n/LanguageContext";

export default function DashboardLoading() {
  const { t } = useLanguage();
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="flex items-center gap-3 text-muted-foreground">
        <div className="w-4 h-4 rounded-full border-2 border-slate-600 border-t-transparent animate-spin" />
        <span className="text-sm">{t("common.loading")}</span>
      </div>
    </div>
  );
}
