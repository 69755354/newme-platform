"use client";

import { useLanguage } from "@/lib/i18n/LanguageContext";
import DispatchWorkbench from "@/components/dispatch/DispatchWorkbench";

export default function DispatchClient() {
  const { t } = useLanguage();
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">{t("dispatch.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("dispatch.subtitle")}</p>
      </div>
      <DispatchWorkbench t={t} />
    </div>
  );
}
