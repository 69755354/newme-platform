"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/i18n/LanguageContext";

/* ─── Types ─── */
interface AdsROIData {
  period: { start_date: string | null; end_date: string | null } | null;
  summary: {
    total_spend: number;
    total_leads: number;
    cpl: number;
    conversions: number;
    signed_amount: number;
    roas: number;
  } | null;
  campaign_breakdown: CampaignRow[];
  source_quality: SourceQualityRow[];
}

interface CampaignRow {
  campaign: string;
  spend: number;
  leads: number;
  cpl: number;
  conversions: number;
  signed_amount: number;
  roas: number;
}

interface SourceQualityRow {
  source: string;
  total: number;
  good: number;
  pending: number;
  bad: number;
  conv_rate: number;
}

function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toFixed(2)}`;
}

function fmtNum(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

/* ─── Component ─── */
export default function AdsROI() {
  const { t } = useLanguage();
  const [data, setData] = useState<AdsROIData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/dashboard/ads-roi");
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
        setError(err.message || t("common.failedToLoad"));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
      <div className="py-8 text-center text-sm text-rose-400">
        {t("common.loadFailed")}: {error}
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

  const { summary, campaign_breakdown, source_quality, period } = data;

  return (
    <div className="space-y-4">
      {/* Period indicator */}
      {period?.start_date && period?.end_date && (
        <p className="text-[11px] text-muted-foreground">
          {t("analytics.campaignPeriod")}: {period.start_date} ~ {period.end_date}
        </p>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {[
          { label: t("analytics.totalSpend"), value: fmtAED(summary.total_spend) },
          { label: t("analytics.totalLeads"), value: fmtNum(summary.total_leads) },
          { label: t("analytics.cpl"), value: fmtAED(summary.cpl) },
          { label: t("analytics.conversions"), value: fmtNum(summary.conversions) },
          { label: t("analytics.signedAmount"), value: fmtAED(summary.signed_amount) },
          { label: t("analytics.roas"), value: summary.roas.toFixed(2) + "x" },
        ].map((card) => (
          <div
            key={card.label}
            className="p-3 rounded-lg border border-border/50 bg-card/50"
          >
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
              {card.label}
            </p>
            <p className="text-lg font-bold text-foreground mt-0.5">
              {card.value}
            </p>
          </div>
        ))}
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
                <TableHead className="text-right">{t("analytics.conversions")}</TableHead>
                <TableHead className="text-right">{t("analytics.signedAmount")}</TableHead>
                <TableHead className="text-right">{t("analytics.roas")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaign_breakdown.map((row) => (
                <TableRow key={row.campaign}>
                  <TableCell className="font-medium max-w-[160px] truncate">
                    {row.campaign}
                  </TableCell>
                  <TableCell className="text-right">
                    {fmtAED(row.spend)}
                  </TableCell>
                  <TableCell className="text-right">{row.leads}</TableCell>
                  <TableCell className="text-right">
                    {fmtAED(row.cpl)}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.conversions}
                  </TableCell>
                  <TableCell className="text-right">
                    {fmtAED(row.signed_amount)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant={row.roas >= 1 ? "default" : "secondary"}
                      className={cn(
                        "text-[10px]",
                        row.roas >= 1
                          ? "bg-emerald-500/10 text-emerald-400"
                          : "bg-rose-500/10 text-rose-400"
                      )}
                    >
                      {row.roas.toFixed(2)}x
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {campaign_breakdown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
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
                <TableHead className="text-right">{t("analytics.qualityPending")}</TableHead>
                <TableHead className="text-right">{t("analytics.qualityBad")}</TableHead>
                <TableHead className="text-right">{t("analytics.conversionRate")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {source_quality.map((row) => (
                <TableRow key={row.source}>
                  <TableCell className="font-medium">{row.source}</TableCell>
                  <TableCell className="text-right">{row.total}</TableCell>
                  <TableCell className="text-right text-emerald-400">
                    {row.good}
                  </TableCell>
                  <TableCell className="text-right text-amber-400">
                    {row.pending}
                  </TableCell>
                  <TableCell className="text-right text-rose-400">
                    {row.bad}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        row.conv_rate >= 20
                          ? "text-emerald-400 border-emerald-500/30"
                          : row.conv_rate >= 10
                          ? "text-amber-400 border-amber-500/30"
                          : "text-muted-foreground"
                      )}
                    >
                      {row.conv_rate}%
                    </Badge>
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
