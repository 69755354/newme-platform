"use client";

import Link from "next/link";
import { useLanguage } from "@/views/i18n/LanguageContext";
import {
  BarChart3, ArrowLeft,
} from "lucide-react";
import { fmtAED } from "@/shared/utils/format";

/* ─── Types ─── */
interface GroupData {
  total: number; valid: number; quoted: number; won: number; value: number;
}

interface AdsClientProps {
  sorted: [string, GroupData][];
  totals: GroupData;
}

export default function AdsClient({ sorted, totals }: AdsClientProps) {
  const { t } = useLanguage();

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link prefetch={false}
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {t("team.backToSettings")}
      </Link>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">
          {t("ads.title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {t("ads.subtitle")}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-blue-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.totalLeads")}</p>
          <p className="text-2xl font-bold text-foreground">{totals.total}</p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-emerald-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.validLeads")}</p>
          <p className="text-2xl font-bold text-emerald-400">{totals.valid}</p>
          <p className="text-[10px] text-muted-foreground">
            {totals.total > 0
              ? `${Math.round((totals.valid / totals.total) * 100)}%`
              : ""}
          </p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-purple-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.quoted")}</p>
          <p className="text-2xl font-bold text-purple-400">{totals.quoted}</p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-emerald-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.won")}</p>
          <p className="text-2xl font-bold text-emerald-400">{totals.won}</p>
          <p className="text-[10px] text-muted-foreground">
            {totals.total > 0
              ? `${Math.round((totals.won / totals.total) * 100)}%`
              : ""}
          </p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-copper-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.value")}</p>
          <p className="text-2xl font-bold text-copper-400">
            {fmtAED(totals.value)}
          </p>
        </div>
      </div>

      {/* Attribution table */}
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 bg-muted/30">
                <th className="text-left py-3 px-4 text-muted-foreground font-medium">
                  {t("ads.bySource")}
                </th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">
                  {t("ads.totalLeads")}
                </th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">
                  {t("ads.validLeads")}
                </th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">
                  {t("ads.validLeads")} %
                </th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">
                  {t("ads.quoted")}
                </th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">
                  {t("ads.won")}
                </th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">
                  {t("pipeline.conversionRate")}
                </th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">
                  {t("ads.value")} (AED)
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(([key, g]) => {
                const validRate =
                  g.total > 0 ? Math.round((g.valid / g.total) * 100) : 0;
                const convRate =
                  g.total > 0 ? Math.round((g.won / g.total) * 100) : 0;
                return (
                  <tr
                    key={key}
                    className="border-b border-border/20 hover:bg-accent/30 transition-colors"
                  >
                    <td className="py-3 px-4 font-medium">{key}</td>
                    <td className="text-right py-3 px-3 font-semibold">
                      {g.total}
                    </td>
                    <td className="text-right py-3 px-3">{g.valid}</td>
                    <td className="text-right py-3 px-3">
                      <span
                        className={
                          validRate >= 50
                            ? "text-emerald-400"
                            : validRate >= 20
                              ? "text-amber-400"
                              : "text-muted-foreground"
                        }
                      >
                        {validRate}%
                      </span>
                    </td>
                    <td className="text-right py-3 px-3">{g.quoted}</td>
                    <td className="text-right py-3 px-3 font-semibold text-emerald-400">
                      {g.won}
                    </td>
                    <td className="text-right py-3 px-3">
                      <span
                        className={
                          convRate >= 20
                            ? "text-emerald-400"
                            : convRate >= 5
                              ? "text-amber-400"
                              : "text-muted-foreground"
                        }
                      >
                        {convRate}%
                      </span>
                    </td>
                    <td className="text-right py-3 px-3 text-copper-400 font-medium">
                      {fmtAED(g.value)}
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="text-center py-8 text-muted-foreground"
                  >
                    {t("ads.noAccountData")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Attribution note */}
      <div className="rounded-xl border border-border/50 p-4 bg-muted/10">
        <div className="flex items-start gap-2">
          <BarChart3 className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-muted-foreground">
              <strong>{t("ads.title")}</strong> — {t("ads.subtitle")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("ads.adminOnlyNote")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
