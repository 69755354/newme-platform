"use client";

import { useLanguage } from "@/views/i18n/LanguageContext";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <div className="w-12 h-12 rounded-full bg-rose-500/10 flex items-center justify-center">
        <span className="text-rose-400 text-lg">!</span>
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-foreground">{t("common.somethingWentWrong")}</p>
        <p className="text-xs text-muted-foreground max-w-md">
          {error.message || t("common.unexpectedError")}
        </p>
      </div>
      <button
        onClick={reset}
        className="px-4 py-2 rounded-lg bg-slate-600 text-foreground text-sm font-medium hover:bg-slate-700 transition-colors"
      >
        {t("common.tryAgain")}
      </button>
    </div>
  );
}
