"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { takeEarlyFetch } from "@/lib/early-fetch";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface AlertsSummary {
  summary: { total: number; red: number; yellow: number; byType: Record<string, number> };
}

/**
 * One calm sentence instead of a pink bar with emoji: "30 条线索超时未跟进 →".
 * It links to the lead list. The number comes from the lead summary when the page
 * passes it (`count`, the same definition as every other lead number); the alerts
 * feed is only the fallback, and it is capped at 30 rows.
 */
export default function AlertPanel({ count }: { count?: number }) {
  const router = useRouter();
  const { t } = useLanguage();
  const [data, setData] = useState<AlertsSummary | null>(null);

  useEffect(() => {
    // The page passes the count from the lead summary; the alerts feed is only a fallback.
    if (count !== undefined) return; // count === undefined only when a caller has no lead summary
    let active = true;
    takeEarlyFetch("/api/alerts")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (active && json) setData(json); })
      .catch(() => { /* silent */ });
    return () => { active = false; };
  }, [count]);

  const total = count ?? data?.summary.total ?? 0;
  if (total <= 0) return null;

  return (
    <button
      type="button"
      onClick={() => router.push("/leads?alert=overdue")}
      className="w-full text-left text-sm font-medium text-amber-300 hover:text-amber-200 transition-colors"
    >
      {t("s37.alertLine").replace("{n}", String(total))} →
    </button>
  );
}
