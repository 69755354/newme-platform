"use client";

import { useSyncExternalStore } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { isUpdateAvailable, subscribeUpdateAvailable } from "@/lib/deployment-skew.mjs";

/**
 * Shown by the dashboard layout once a tab-return probe has seen a newer
 * release than this tab runs. It never reloads on its own: the user may be in
 * the middle of a form. Clicking it reloads.
 */
export function ReleaseUpdateBanner() {
  const { t } = useLanguage();
  const updateAvailable = useSyncExternalStore(subscribeUpdateAvailable, isUpdateAvailable, () => false);
  if (!updateAvailable) return null;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      role="status"
      data-testid="release-update-banner"
      className="w-full bg-amber-100 text-amber-900 text-sm px-4 py-2 text-center hover:bg-amber-200"
    >
      {t("common.systemUpdatedRefresh")}
    </button>
  );
}
