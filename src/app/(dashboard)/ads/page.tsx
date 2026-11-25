"use client";

import { useEffect, useState, useMemo } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { useRequireRole } from "@/hooks/useRequireRole";
import { cn } from "@/lib/utils";
import { BarChart3, ArrowLeft, Search, X } from "lucide-react";
import Link from "next/link";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

import { aggregateAttribution, type MetricLead } from "@/lib/lead-metrics.mjs";
import { attributionGroup, buildAdNameMap } from "@/lib/ads-leads.mjs";
import { addDaysToDateKey, dubaiDateKey } from "@/lib/dubai-time.mjs";
import { translatedOrRaw } from "@/lib/chart-labels.mjs";
import { onFetchFailure } from "@/lib/fetch-interruption";
import { formatAED } from "@/lib/display-format.mjs";

interface Lead {
  id: string; customer_name: string | null;
  source: string; stage: string; final_status: string | null; quotation_value: number | null;
  lead_status: string | null; win_probability: number | null;
  meta_campaign: string | null;
  source_platform: string | null; source_channel: string | null;
  campaign_id: string | null; campaign_name: string | null;
  adset_id: string | null; adset_name: string | null;
  ad_id: string | null; ad_name: string | null;
  creative_id: string | null; creative_name: string | null;
  form_id: string | null; form_name: string | null;
  utm_source: string | null; utm_medium: string | null;
  utm_campaign: string | null; utm_content: string | null;
  utm_term: string | null;
  landing_page: string | null; referrer: string | null;
  first_touch_at: string | null; last_touch_at: string | null;
  created_at: string;
  quality: string;
  ctwa_clid?: string | null;
}

interface RoiRow { spend: number | null; leads: number; cpl: number | null }
interface RoiData {
  data_last_updated: string | null;
  spend_stale: boolean;
  spend_days_old: number | null;
  summary: { total_spend: number | null; total_leads: number; cpl: number | null } | null;
  weekly_breakdown: Array<RoiRow & { week_start: string; week_end: string }>;
  ad_breakdown: Array<RoiRow & { ad: string; ad_id: string | null; spend_ambiguous?: boolean }>;
}

const WINDOW_OPTIONS = [7, 30, 90, 0] as const; // 0 = all time (leads only; spend follows 90 days)

// S37: whole dirhams with thousands separators.
const fmtAED = formatAED;

export default function AdsPage() {
  // operator included: /api/ads/leads answers every non-sales role, and the
  // sidebar offers this link to operator, so excluding them here was a bounce
  // to /dashboard rather than a decision.
  const { loading: roleLoading, blocked, role: userRole } = useRequireRole(["admin", "boss", "operator"]);
  const { t, lang } = useLanguage();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"source" | "campaign" | "adset" | "ad">("source");
  const [days, setDays] = useState<number>(30);
  const [roi, setRoi] = useState<RoiData | null>(null);
  const [roiLoading, setRoiLoading] = useState(false);
  const [roiError, setRoiError] = useState(false);

  useEffect(() => {
    if (roleLoading) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/ads/leads");
        if (!res.ok) throw new Error("Failed to fetch");
        const json = await res.json();
        const resolvedRole = json.role ?? userRole ?? "sales";
        setRole(resolvedRole);
        if (resolvedRole === "sales") {
          setLoading(false);
          return;
        }
        if (json.leads) setLeads(json.leads as Lead[]);
      } catch (err) {
        onFetchFailure(err, () => {
          console.error("Failed to fetch leads:", err);
          setError(t("common.loadFailedRetry"));
        }, { isActive: () => active });
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [roleLoading, userRole]);

  // Spend and cost per lead exist for boss/admin only (the ads-roi route is closed to operator).
  useEffect(() => {
    if (roleLoading || !role || !["admin", "boss"].includes(role)) return;
    let active = true;
    // The previous window's figures must not stay on screen under the new window's label.
    setRoi(null);
    setRoiError(false);
    setRoiLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/ads-roi?days=${days === 0 ? 90 : days}`);
        if (!res.ok) throw new Error("ads-roi failed");
        const json = await res.json();
        if (active) { setRoi(json as RoiData); setRoiLoading(false); }
      } catch (err) {
        onFetchFailure(err, () => {
          console.error("Failed to fetch ads ROI:", err);
          setRoi(null); setRoiError(true); setRoiLoading(false);
        }, { isActive: () => active });
      }
    })();
    return () => { active = false; };
  }, [roleLoading, role, days]);

  // Same Dubai-date window as the spend side; 0 = every lead.
  const windowedLeads = useMemo(() => {
    if (days === 0) return leads;
    const since = addDaysToDateKey(dubaiDateKey() as string, -(days - 1));
    return leads.filter((l) => {
      const k = dubaiDateKey(l.created_at);
      return k !== null && k >= since;
    });
  }, [leads, days]);

  const adNames = useMemo(() => buildAdNameMap(leads), [leads]);

  const grouped = useMemo(() => {
    // Same counting as /settings/ads (src/lib/lead-metrics.mjs): archived leads
    // excluded, valid = good/normal quality, quoted/won from stage + final_status.
    // ad_id (when present) is the key, the name only labels it; a click-to-WhatsApp lead has an ad id and no
    // campaign name, so it shows under its ad instead of "uncategorized".
    const labels = new Map<string, string>();
    const groups = aggregateAttribution(windowedLeads as unknown as MetricLead[], (lead) => {
      const g = attributionGroup(lead as never, viewMode, adNames);
      if (g.label) labels.set(g.key, g.label);
      return g.key;
    });

    return Object.entries(groups)
      .map(([k, g]) => ({ key: k, label: labels.get(k) ?? k, g }))
      .filter((r) => r.label.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.g.total - a.g.total);
  }, [windowedLeads, adNames, viewMode, search]);

  const totalStats = useMemo(() => {
    let total = 0, valid = 0, rated = 0, unrated = 0, waAd = 0;
    for (const r of grouped) { total += r.g.total; valid += r.g.valid; rated += r.g.rated; unrated += r.g.unrated; waAd += r.g.waAd; }
    return { total, valid, rated, unrated, waAd };
  }, [grouped]);

  if (roleLoading || blocked) return null;

  // No spend rows at all in the window: say so once, instead of an empty cost column.
  const spendMissing = roi !== null && !roi.data_last_updated;
  const noSpendInWindow = roi !== null && !spendMissing && roi.summary?.total_spend == null;
  const pctOfRated = (valid: number, rated: number) => (rated > 0 ? `${Math.round((valid / rated) * 100)}%` : "—");

  const viewLabels: Record<string, string> = {
    source: t("ads.bySource"), campaign: t("ads.byCampaign"), adset: t("ads.byAdSet"), ad: t("ads.byAd"),
  };

  if (loading) return <div className="text-center py-16 text-muted-foreground">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (role === "sales") {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <h2 className="text-xl font-semibold text-foreground mb-2">{t("ads.noAccess")}</h2>
        <p className="text-muted-foreground text-sm">{t("ads.noAccessDesc")}</p>
      </div>
    );
  }

  return (
    <DashboardScrollContainer>
      <Link prefetch={false} href="/leads" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />{t("ads.backToLeads")}
      </Link>
      <div className="space-y-6 mt-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">{t("ads.title")}</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {t("ads.subtitle")}
        </p>
      </div>

      {/* Spend freshness: the Meta sync is what moves it */}
      {spendMissing && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700" data-testid="spend-not-connected">
          <p className="font-medium">{t("ads.spendNotConnected")}</p>
          <p className="text-xs text-amber-700/80 mt-0.5">{t("ads.spendNotConnectedHint")}</p>
        </div>
      )}
      {noSpendInWindow && !roi?.spend_stale && (
        <p className="text-xs text-muted-foreground" data-testid="no-spend-in-window">{t("ads.noSpendInWindow")}</p>
      )}
      {roi?.spend_stale && roi.data_last_updated && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700">
          {t("ads.staleBanner").replace("{date}", roi.data_last_updated).replace("{n}", String(roi.spend_days_old ?? ""))}
        </div>
      )}
      {roiLoading && <p className="text-xs text-muted-foreground">{t("common.loading")}</p>}
      {roiError && <p className="text-xs text-red-700">{t("common.loadFailedRetry")}</p>}
      {roi && (
        <p className="text-xs text-muted-foreground">{t("ads.dataUpdated")}: {roi.data_last_updated ?? "—"}</p>
      )}
      {/* "All" reads spend over 90 days (see WINDOW_OPTIONS): say so wherever spend is shown */}
      {roi && days === 0 && <p className="text-xs text-amber-700" data-testid="roi-period-90">{t("ads.roiPeriod90")}</p>}

      {/* Summary: leads, cost per lead - the return stops at leads */}
      <div className={cn("grid grid-cols-2 gap-3", roi?.summary && !spendMissing && !noSpendInWindow ? "md:grid-cols-5" : "md:grid-cols-2")}>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-blue-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.totalLeads")}</p>
          <p className="text-2xl font-bold text-foreground">{totalStats.total}</p>
          {/* S42 (F07④): which window and which grouping this total is counted on */}
          <p className="text-xs text-muted-foreground mt-0.5" data-testid="ads-scope">
            {t("s42.ads.scope").replace("{window}", days === 0 ? t("ads.windowAll") : t("ads.windowDays").replace("{n}", String(days))).replace("{group}", lang === "en" ? viewLabels[viewMode].toLowerCase() : viewLabels[viewMode])}
          </p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-emerald-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.validLeads")}</p>
          <p className="text-2xl font-bold text-emerald-700">{totalStats.valid}</p>
          <p className="text-xs text-muted-foreground">
            {t("ads.validOfRated").replace("{valid}", String(totalStats.valid)).replace("{rated}", String(totalStats.rated)).replace("{unrated}", String(totalStats.unrated))}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{t("ads.validNote")}</p>
        </div>
        {roi?.summary && !spendMissing && !noSpendInWindow && (
          <>
            <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-purple-500/5 to-transparent">
              <p className="text-xs text-muted-foreground">{t("ads.spend")}</p>
              <p className="text-2xl font-bold text-foreground">{fmtAED(roi.summary.total_spend)}</p>
            </div>
            <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-blue-500/5 to-transparent">
              <p className="text-xs text-muted-foreground">{t("ads.adLeads")}</p>
              <p className="text-2xl font-bold text-foreground">{roi.summary.total_leads}</p>
            </div>
            <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-copper-500/5 to-transparent">
              <p className="text-xs text-muted-foreground">{t("ads.cpl")}</p>
              <p className="text-2xl font-bold text-copper-700">{fmtAED(roi.summary.cpl)}</p>
            </div>
          </>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input placeholder={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-8 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground" />
          {search && <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="w-4 h-4" /></button>}
        </div>
        <div className="flex gap-1 bg-muted p-1 rounded-lg">
          {(Object.entries(viewLabels) as [string, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setViewMode(key as typeof viewMode)}
              className={cn("px-3 py-1.5 text-xs rounded-md font-medium transition-colors",
                viewMode === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-muted p-1 rounded-lg">
          {WINDOW_OPTIONS.map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className={cn("px-3 py-1.5 text-xs rounded-md font-medium transition-colors",
                days === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {d === 0 ? t("ads.windowAll") : t("ads.windowDays").replace("{n}", String(d))}
            </button>
          ))}
        </div>
      </div>

      {/* Attribution Table */}
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 bg-muted/30">
                <th className="text-left py-3 px-4 text-muted-foreground font-medium">{viewLabels[viewMode]}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.totalLeads")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.ratedLeads")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.notYetRated")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.validLeads")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.validLeads")} / {t("ads.ratedLeads")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.lastTouch")}</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ key, label, g }) => {
                const validRate = g.rated > 0 ? Math.round((g.valid / g.rated) * 100) : null;
                return (
                  <tr key={key} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                    <td className="py-3 px-4 font-medium">{viewMode === "source" ? translatedOrRaw(t, `sourceLabels.${key}`, key) : label}</td>
                    <td className="text-right py-3 px-3 font-semibold">{g.total}</td>
                    <td className="text-right py-3 px-3">{g.rated}</td>
                    <td className="text-right py-3 px-3 text-muted-foreground">{g.unrated}</td>
                    <td className="text-right py-3 px-3">{g.valid}</td>
                    <td className="text-right py-3 px-3">
                      <span className={cn(validRate === null ? "text-muted-foreground" : validRate >= 50 ? "text-emerald-700" : validRate >= 20 ? "text-amber-700" : "text-muted-foreground")}>
                        {pctOfRated(g.valid, g.rated)}
                      </span>
                    </td>
                    <td className="text-right py-3 px-3">{g.waAd > 0 ? g.waAd : "—"}</td>
                  </tr>
                );
              })}
              {grouped.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">{t("common.noResults")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t("ads.lastTouchNote")}</p>

      {/* Cost per lead per week and per ad (boss/admin only: spend is not shown to operator) */}
      {roi && (
        <div className="grid gap-4 md:grid-cols-2">
          {days === 0 && <p className="md:col-span-2 text-xs text-amber-700">{t("ads.roiPeriod90")}</p>}
          <div className="rounded-xl border border-border/50 overflow-hidden">
            <h3 className="px-4 py-2 text-sm font-semibold bg-muted/30">{t("ads.cplByWeek")}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border/50 text-muted-foreground">
                  <th className="text-left py-2 px-4 font-medium">{t("ads.week")}</th>
                  {!spendMissing && <th className="text-right py-2 px-3 font-medium">{t("ads.spend")}</th>}
                  <th className="text-right py-2 px-3 font-medium">{t("ads.totalLeads")}</th>
                  {!spendMissing && <th className="text-right py-2 px-3 font-medium">{t("ads.cpl")}</th>}
                </tr></thead>
                <tbody>
                  {roi.weekly_breakdown.map((w) => (
                    <tr key={w.week_start} className="border-b border-border/20">
                      <td className="py-2 px-4">{w.week_start} ~ {w.week_end}</td>
                      {!spendMissing && <td className="text-right py-2 px-3">{fmtAED(w.spend)}</td>}
                      <td className="text-right py-2 px-3">{w.leads}</td>
                      {!spendMissing && <td className="text-right py-2 px-3 font-medium">{fmtAED(w.cpl)}</td>}
                    </tr>
                  ))}
                  {roi.weekly_breakdown.length === 0 && <tr><td colSpan={spendMissing ? 2 : 4} className="text-center py-6 text-muted-foreground">{t("common.noResults")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="rounded-xl border border-border/50 overflow-hidden">
            <h3 className="px-4 py-2 text-sm font-semibold bg-muted/30">{t("ads.cplByAd")}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border/50 text-muted-foreground">
                  <th className="text-left py-2 px-4 font-medium">{t("ads.byAd")}</th>
                  {!spendMissing && <th className="text-right py-2 px-3 font-medium">{t("ads.spend")}</th>}
                  <th className="text-right py-2 px-3 font-medium">{t("ads.totalLeads")}</th>
                  {!spendMissing && <th className="text-right py-2 px-3 font-medium">{t("ads.cpl")}</th>}
                </tr></thead>
                <tbody>
                  {roi.ad_breakdown.map((a) => (
                    <tr key={`${a.ad_id ?? ""}|${a.ad}`} className="border-b border-border/20">
                      <td className="py-2 px-4 max-w-[220px] truncate">{a.ad}</td>
                      {!spendMissing && <td className="text-right py-2 px-3">{a.spend_ambiguous && a.spend === null ? "?" : fmtAED(a.spend)}</td>}
                      <td className="text-right py-2 px-3">{a.leads}</td>
                      {!spendMissing && <td className="text-right py-2 px-3 font-medium">{fmtAED(a.cpl)}</td>}
                    </tr>
                  ))}
                  {roi.ad_breakdown.length === 0 && <tr><td colSpan={spendMissing ? 2 : 4} className="text-center py-6 text-muted-foreground">{t("common.noResults")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Attribution note */}
      <div className="rounded-xl border border-border/50 p-4 bg-muted/10">
        <div className="flex items-start gap-2">
          <BarChart3 className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-muted-foreground">
              <strong>{t("ads.title")} — </strong>
              {t("ads.subtitle")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("ads.bySource")}: {viewLabels[viewMode]}
            </p>
          </div>
        </div>
      </div>
    </div>
    </DashboardScrollContainer>
  );
}
