"use client";

/**
 * SalesKpiDashboard — T3-3 step 2 extracted from pipeline/page.tsx
 *
 * Renders the Sales role's KPI performance view: header, signing/collection
 * cards with progress bars, and detail breakdown grid.
 *
 * Pure presentational. All data fetching lives in useSalesKpiData.
 * The `role === "sales"` guard stays in the parent (pipeline/page.tsx) so this
 * component is only mounted for sales users.
 */

import { useLanguage } from "@/lib/i18n/LanguageContext";
import { cn } from "@/lib/utils";
import {
  Target, TrendingUp, Wallet, DollarSign, CheckCircle2,
} from "lucide-react";
import { useSalesKpiData } from "../_hooks/useSalesKpiData";

/* ─── Local helpers (purely rendering concerns) ─── */
function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

function kpiPctColor(v: number | null): string {
  if (v === null) return "text-muted-foreground";
  if (v >= 100) return "text-emerald-400";
  if (v >= 50) return "text-amber-400";
  return "text-rose-400";
}

/* ─── Component ─── */
export function SalesKpiDashboard({ currentUserId }: { currentUserId: string | null }) {
  const { t } = useLanguage();
  const {
    signingTarget, signingActual, signingPct,
    collectionTarget, collectionActual, collectionPct,
    contractCount, isLoading: kpiLoading,
  } = useSalesKpiData(currentUserId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
          <Target className="w-6 h-6 text-copper-400" />
          {t("kpi.title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {new Date().toISOString().slice(0, 7)} {t("kpi.subtitle")}
          {kpiLoading && <span className="ml-2 text-[10px] text-muted-foreground animate-pulse">{t("common.loading")}</span>}
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {/* Signing KPI */}
        <div className="rounded-xl border border-border/50 bg-card/50 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-copper-400" />
              <span className="text-sm font-semibold text-foreground">{t("kpi.signing")}</span>
            </div>
            <span className="text-xs text-muted-foreground">{contractCount} {t("kpi.contracts")}</span>
          </div>
          <div className="text-center">
            <p className={cn("text-4xl font-bold leading-none", kpiPctColor(signingPct))}>
              {signingPct !== null ? `${signingPct}%` : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {fmtAED(signingActual)} / {signingTarget > 0 ? fmtAED(signingTarget) : t("kpi.noTargetSet")}
            </p>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-700", signingPct !== null && signingPct >= 100 ? "bg-emerald-500" : signingPct !== null && signingPct >= 50 ? "bg-amber-500" : "bg-rose-500")}
              style={{ width: `${Math.min(signingPct ?? 0, 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("kpi.target")}: {signingTarget > 0 ? fmtAED(signingTarget) : "—"}</span>
            <span>{t("kpi.actual")}: {fmtAED(signingActual)}</span>
          </div>
        </div>

        {/* Collection KPI */}
        <div className="rounded-xl border border-border/50 bg-card/50 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-emerald-400" />
              <span className="text-sm font-semibold text-foreground">{t("kpi.collection")}</span>
            </div>
            {collectionPct !== null && collectionPct >= 100 && (
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            )}
          </div>
          <div className="text-center">
            <p className={cn("text-4xl font-bold leading-none", kpiPctColor(collectionPct))}>
              {collectionPct !== null ? `${collectionPct}%` : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {fmtAED(collectionActual)} / {collectionTarget > 0 ? fmtAED(collectionTarget) : t("kpi.noTargetSet")}
            </p>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-700", collectionPct !== null && collectionPct >= 100 ? "bg-emerald-500" : collectionPct !== null && collectionPct >= 50 ? "bg-amber-500" : "bg-rose-500")}
              style={{ width: `${Math.min(collectionPct ?? 0, 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("kpi.target")}: {collectionTarget > 0 ? fmtAED(collectionTarget) : "—"}</span>
            <span>{t("kpi.actual")}: {fmtAED(collectionActual)}</span>
          </div>
        </div>
      </div>

      {/* Detail breakdown */}
      <div className="rounded-xl border border-border/50 p-5">
        <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-copper-400" />
          {t("kpi.detailData")}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-lg bg-muted/30">
            <p className="text-xs text-muted-foreground">{t("kpi.contractCount")}</p>
            <p className="text-xl font-bold text-foreground mt-1">{contractCount}</p>
          </div>
          <div className="p-4 rounded-lg bg-muted/30">
            <p className="text-xs text-muted-foreground">{t("kpi.totalSigning")}</p>
            <p className="text-xl font-bold text-copper-400 mt-1">{fmtAED(signingActual)}</p>
          </div>
          <div className="p-4 rounded-lg bg-muted/30">
            <p className="text-xs text-muted-foreground">{t("kpi.totalCollected")}</p>
            <p className="text-xl font-bold text-emerald-400 mt-1">{fmtAED(collectionActual)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
