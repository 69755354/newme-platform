"use client";

import { useLanguage } from "@/lib/i18n/LanguageContext";

/**
 * The one "connection failed · retry" view. Rendered by the dashboard layout
 * when its own session read, or any page's session read, stays unavailable
 * after the reader's retries, and by the server-rendered pages when their
 * session check could not complete. Never shown for a real refusal: those go
 * to /login.
 */
export function ConnectionFailed({ onRetry }: { onRetry?: () => void } = {}) {
  const { t } = useLanguage();
  const retry = onRetry ?? (() => window.location.reload());
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-3" role="alert" data-testid="connection-failed">
      <p className="text-rose-400 text-sm">{t("common.connectionFailed")}</p>
      <p className="text-xs text-muted-foreground">{t("common.connectionFailedHint")}</p>
      <button type="button" onClick={retry} className="text-xs text-slate-600 underline">
        {t("common.retry")}
      </button>
    </div>
  );
}
