"use client";

import { useLanguage } from "@/lib/i18n/LanguageContext";
import VisitPanel from "@/components/opportunity-visit/VisitPanel";

export default function VisitsClient({ role }: { role: string }) {
  const { t } = useLanguage();
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">{t("visits.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("visits.subtitle")}</p>
      </div>
      <VisitPanel t={t} role={role} />
    </div>
  );
}
