"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { translatedOrRaw } from "@/lib/chart-labels.mjs";
import { formatAED } from "@/lib/display-format.mjs";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { onFetchFailure } from "@/lib/fetch-interruption";

/* ─── Types ─── */
interface AdsROIData {
  period: { start_date: string | null; end_date: string | null } | null;
  data_last_updated: string | null;
  spend_stale: boolean;
  spend_days_old: number | null;
  summary: { total_spend: number | null; total_leads: number; cpl: number | null } | null;
  campaign_breakdown: CampaignRow[];
  ad_breakdown: AdRow[];
  weekly_breakdown: WeekRow[];
  source_quality: SourceQualityRow[];
}

interface CampaignRow { campaign: string; spend: number | null; leads: number; cpl: number | null }
interface AdRow { ad: string; ad_id: string | null; spend: number | null; leads: number; cpl: number | null }
interface WeekRow { week_start: string; week_end: string; spend: number | null; leads: number; cpl: number | null }

const WINDOWS = [7, 30, 90] as const;

interface SourceQualityRow {
  source: string;
  total: number;
  good: number;
  normal: number;
  pending: number;
  bad: number;
  conv_rate: number;
}

function finite(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

// S37: whole dirhams with thousands separators ("AED 12,345"), never "12K".
function fmtAED(value: number | null | undefined): string {
  return formatAED(finite(value));
}

function fmtNum(value: number | null | undefined): string {
  const v = finite(value);
  if (v === null) return "—";
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ─── Component ─── */
export default function AdsROI() {
  const { t } = useLanguage();
  const [data, setData] = useState<AdsROIData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(30);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/ads-roi?days=${days}`);
        if (!res.ok) {
          if (res.status === 403) {
            setError(t("common.forbidden"));
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        setData(json);
      } catch (err: any) {
        onFetchFailure(err, () => {
          console.error("[analytics] ads roi fetch failed:", err);
          setError(t("common.loadFailed"));
        }, { isActive: () => active });
      } finally {
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [days]);

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("analytics.loadingAds")}
      </div>
    );
  }

  if (error === "forbidden") {
    return null; // Don't render anything for non-CEO/Admin
  }

  if (error) {
    return (
      <div className="py-8 text-center text-sm text-rose-700">
        {error}
      </div>
    );
  }

  if (!data || !data.summary) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("analytics.noAdsData")}
      </div>
    );
  }

  const { summary, campaign_breakdown, ad_breakdown, weekly_breakdown, source_quality, period } = data;

  return (
    <div className="space-y-4">
      {/* Data freshness: spend only moves when the Meta sync runs */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 bg-muted p-1 rounded-lg">
          {WINDOWS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                "px-3 py-1 text-xs rounded-md font-medium transition-colors",
                days === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("analytics.adsLastDays").replace("{n}", String(d))}
            </button>
          ))}
        </div>
        {period?.start_date && period?.end_date && (
          <p className="text-xs text-muted-foreground">
            {t("analytics.campaignPeriod")}: {period.start_date} ~ {period.end_date}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("analytics.adsDataUpdated")}: {data.data_last_updated ?? "—"}
        </p>
      </div>
      {data.spend_stale && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700">
          {data.data_last_updated
            ? t("analytics.adsStaleBanner").replace("{date}", data.data_last_updated).replace("{n}", String(data.spend_days_old ?? ""))
            : t("analytics.adsNoSpendBanner")}
        </div>
      )}

      {/* Summary cards: spend, leads, cost per lead (the return stops at leads) */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: t("analytics.totalSpend"), value: fmtAED(summary.total_spend) },
          { label: t("analytics.adLeadsWindow").replace("{n}", String(days)), value: fmtNum(summary.total_leads) },
          { label: t("analytics.cpl"), value: fmtAED(summary.cpl) },
        ].map((card) => (
          <div key={card.label} className="p-3 rounded-lg border border-border/50 bg-card/50">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{card.label}</p>
            <p className="text-lg font-bold text-foreground mt-0.5">{card.value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("analytics.adLeadsWindowNote").replace("{n}", String(days))}
        {summary.total_spend === null && <> {t("ads.spendNotConnected")}</>}
      </p>

      {/* Per week */}
      <div>
        <h3 className="text-xs font-semibold text-foreground mb-2">{t("analytics.adsByWeek")}</h3>
        <div className="rounded-lg border border-border/50 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("analytics.adsWeek")}</TableHead>
                <TableHead className="text-right">{t("analytics.totalSpend")}</TableHead>
                <TableHead className="text-right">{t("analytics.totalLeads")}</TableHead>
                <TableHead className="text-right">{t("analytics.cpl")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weekly_breakdown.map((row) => (
                <TableRow key={row.week_start}>
                  <TableCell className="font-medium">{row.week_start} ~ {row.week_end}</TableCell>
                  <TableCell className="text-right">{fmtAED(row.spend)}</TableCell>
                  <TableCell className="text-right">{row.leads}</TableCell>
                  <TableCell className="text-right">{fmtAED(row.cpl)}</TableCell>
                </TableRow>
              ))}
              {weekly_breakdown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-6">{t("analytics.noCampaignData")}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Per ad */}
      <div>
        <h3 className="text-xs font-semibold text-foreground mb-2">{t("analytics.adsByAd")}</h3>
        <div className="rounded-lg border border-border/50 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("analytics.adsAd")}</TableHead>
                <TableHead className="text-right">{t("analytics.totalSpend")}</TableHead>
                <TableHead className="text-right">{t("analytics.totalLeads")}</TableHead>
                <TableHead className="text-right">{t("analytics.cpl")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ad_breakdown.map((row) => (
                <TableRow key={`${row.ad_id ?? ""}|${row.ad}`}>
                  <TableCell className="font-medium max-w-[220px] truncate">{row.ad}</TableCell>
                  <TableCell className="text-right">{fmtAED(row.spend)}</TableCell>
                  <TableCell className="text-right">{row.leads}</TableCell>
                  <TableCell className="text-right">{fmtAED(row.cpl)}</TableCell>
                </TableRow>
              ))}
              {ad_breakdown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-6">{t("analytics.noCampaignData")}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Campaign table */}
      <div>
        <h3 className="text-xs font-semibold text-foreground mb-2">
          {t("analytics.campaignBreakdown")}
        </h3>
        <div className="rounded-lg border border-border/50 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("analytics.campaignBreakdown").split(" ")[0]}</TableHead>
                <TableHead className="text-right">{t("analytics.totalSpend")}</TableHead>
                <TableHead className="text-right">{t("analytics.totalLeads")}</TableHead>
                <TableHead className="text-right">{t("analytics.cpl")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaign_breakdown.map((row) => (
                <TableRow key={row.campaign}>
                  <TableCell className="font-medium max-w-[220px] truncate">{row.campaign}</TableCell>
                  <TableCell className="text-right">{fmtAED(row.spend)}</TableCell>
                  <TableCell className="text-right">{row.leads}</TableCell>
                  <TableCell className="text-right">{fmtAED(row.cpl)}</TableCell>
                </TableRow>
              ))}
              {campaign_breakdown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                    {t("analytics.noCampaignData")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Source vs Quality table */}
      <div>
        <h3 className="text-xs font-semibold text-foreground mb-2">
          {t("analytics.sourceVsQuality")}
        </h3>
        <div className="rounded-lg border border-border/50 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("analytics.sourceVsQuality").split(" ")[0]}</TableHead>
                <TableHead className="text-right">{t("analytics.totalLeads")}</TableHead>
                <TableHead className="text-right">{t("analytics.qualityGood")}</TableHead>
                <TableHead className="text-right">{t("analytics.qualityNormal")}</TableHead>
                <TableHead className="text-right">{t("analytics.qualityPending")}</TableHead>
                <TableHead className="text-right">{t("analytics.qualityBad")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {source_quality.map((row) => (
                <TableRow key={row.source}>
                  <TableCell className="font-medium">{translatedOrRaw(t, `sourceLabels.${row.source}`, row.source)}</TableCell>
                  <TableCell className="text-right">{row.total}</TableCell>
                  <TableCell className="text-right text-emerald-700">
                    {row.good}
                  </TableCell>
                  <TableCell className="text-right text-sky-700">
                    {row.normal}
                  </TableCell>
                  <TableCell className="text-right text-amber-700">
                    {row.pending}
                  </TableCell>
                  <TableCell className="text-right text-rose-700">
                    {row.bad}
                  </TableCell>
                </TableRow>
              ))}
              {source_quality.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    {t("analytics.noSourceData")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
