"use client";

import { useLanguage } from "@/lib/i18n/LanguageContext";
import OpportunityPanel from "@/components/opportunity-visit/OpportunityPanel";

export default function OpportunitiesClient() {
  const { t, lang } = useLanguage();
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">{t("opportunities.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("opportunities.subtitle")}</p>
      </div>
      <OpportunityPanel t={t} lang={lang} />
    </div>
  );
}
