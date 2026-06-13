"use client";

import { useEffect, useState, useMemo } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { useRequireRole } from "@/hooks/useRequireRole";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  BarChart3, TrendingUp, Users, DollarSign, Target, ArrowLeft,
  ExternalLink, Filter, Search, X,
} from "lucide-react";
import Link from "next/link";

interface Lead {
  id: string; customer_name: string | null;
  source: string; stage: string; quotation_value: number | null;
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
}

function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

export default function AdsPage() {
  const { loading: roleLoading, blocked } = useRequireRole(["admin", "boss"]);
  const supabase = createClient();
  const { t } = useLanguage();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"source" | "campaign" | "adset" | "ad">("source");

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        const resolvedRole = profile?.role ?? "sales";
        setRole(resolvedRole);
        // Sales users have no access to ads analytics — skip data fetch entirely
        if (resolvedRole === "sales") {
          setLoading(false);
          return;
        }
      }
      const { data, error: err } = await supabase.from("leads").select("*").order("created_at", { ascending: false }).limit(500);
      if (err) {
        console.error("Failed to fetch leads:", err);
        setError(t("common.loadFailedRetry"));
        setLoading(false);
        return;
      }
      if (data) setLeads(data as Lead[]);
      setLoading(false);
    })();
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<string, { total: number; valid: number; quoted: number; won: number; value: number }> = {};

    const getKey = (l: Lead): string => {
      switch (viewMode) {
        case "source": return l.source_platform || l.source || "other";
        case "campaign": return l.campaign_name || l.utm_campaign || l.meta_campaign || "uncategorized";
        case "adset": return l.adset_name || "uncategorized";
        case "ad": return l.ad_name || "uncategorized";
        default: return "other";
      }
    };

    for (const l of leads) {
      const key = getKey(l);
      if (!groups[key]) groups[key] = { total: 0, valid: 0, quoted: 0, won: 0, value: 0 };
      groups[key].total++;
      if (l.quality === "valid") groups[key].valid++;
      if (l.stage === "quotation_submitted" || l.stage === "negotiation" || l.stage === "pending_decision" || l.stage === "won") groups[key].quoted++;
      if (l.stage === "won") groups[key].won++;
      groups[key].value += l.quotation_value || 0;
    }

    return Object.entries(groups)
      .filter(([k]) => k.toLowerCase().includes(search.toLowerCase()))
      .sort(([, a], [, b]) => b.total - a.total);
  }, [leads, viewMode, search]);

  const totalStats = useMemo(() => {
    let total = 0, valid = 0, quoted = 0, won = 0, value = 0;
    for (const [, g] of grouped) {
      total += g.total; valid += g.valid; quoted += g.quoted;
      won += g.won; value += g.value;
    }
    return { total, valid, quoted, won, value };
  }, [grouped]);

  if (roleLoading || blocked) return null;

  const viewLabels: Record<string, string> = {
    source: t("ads.bySource"), campaign: t("ads.byCampaign"), adset: t("ads.byAdSet"), ad: t("ads.byAd"),
  };

  if (loading) return <div className="text-center py-16 text-muted-foreground">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (role === "sales") {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <div className="text-6xl mb-4">🚫</div>
        <h2 className="text-xl font-semibold text-foreground mb-2">{t("ads.noAccess")}</h2>
        <p className="text-muted-foreground text-sm">{t("ads.noAccessDesc")}</p>
      </div>
    );
  }

  return (
    <>
      <Link href="/leads" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />Back to Leads
      </Link>
      <div className="space-y-6 mt-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">{t("ads.title")}</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {t("ads.subtitle")}
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-blue-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.totalLeads")}</p>
          <p className="text-2xl font-bold text-foreground">{totalStats.total}</p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-emerald-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.validLeads")}</p>
          <p className="text-2xl font-bold text-emerald-400">{totalStats.valid}</p>
          <p className="text-[10px] text-muted-foreground">{totalStats.total > 0 ? `${Math.round((totalStats.valid / totalStats.total) * 100)}%` : ""}</p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-purple-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.quoted")}</p>
          <p className="text-2xl font-bold text-purple-400">{totalStats.quoted}</p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-emerald-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.won")}</p>
          <p className="text-2xl font-bold text-emerald-400">{totalStats.won}</p>
          <p className="text-[10px] text-muted-foreground">{totalStats.total > 0 ? `${Math.round((totalStats.won / totalStats.total) * 100)}%` : ""}</p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-gradient-to-br from-copper-500/5 to-transparent">
          <p className="text-xs text-muted-foreground">{t("ads.value")}</p>
          <p className="text-2xl font-bold text-copper-400">{fmtAED(totalStats.value)}</p>
        </div>
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
            <button key={key} onClick={() => setViewMode(key as any)}
              className={cn("px-3 py-1.5 text-xs rounded-md font-medium transition-colors",
                viewMode === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {label}
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
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.validLeads")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.validLeads")} %</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.quoted")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.won")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("dashboard.conversionRate")}</th>
                <th className="text-right py-3 px-3 text-muted-foreground font-medium">{t("ads.value")} (AED)</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([key, g]) => {
                const validRate = g.total > 0 ? Math.round((g.valid / g.total) * 100) : 0;
                const convRate = g.total > 0 ? Math.round((g.won / g.total) * 100) : 0;
                return (
                  <tr key={key} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                    <td className="py-3 px-4 font-medium">{t(`sourceLabels.${key}`) || key}</td>
                    <td className="text-right py-3 px-3 font-semibold">{g.total}</td>
                    <td className="text-right py-3 px-3">{g.valid}</td>
                    <td className="text-right py-3 px-3">
                      <span className={cn(validRate >= 50 ? "text-emerald-400" : validRate >= 20 ? "text-amber-400" : "text-muted-foreground")}>
                        {validRate}%
                      </span>
                    </td>
                    <td className="text-right py-3 px-3">{g.quoted}</td>
                    <td className="text-right py-3 px-3 font-semibold text-emerald-400">{g.won}</td>
                    <td className="text-right py-3 px-3">
                      <span className={cn(convRate >= 20 ? "text-emerald-400" : convRate >= 5 ? "text-amber-400" : "text-muted-foreground")}>
                        {convRate}%
                      </span>
                    </td>
                    <td className="text-right py-3 px-3 text-copper-400 font-medium">{fmtAED(g.value)}</td>
                  </tr>
                );
              })}
              {grouped.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">{t("common.noResults")}</td></tr>
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
    </>
  );
}
