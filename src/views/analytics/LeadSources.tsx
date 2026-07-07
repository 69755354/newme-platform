"use client";

import { useEffect, useState, useMemo } from "react";
import { cn } from "@/models/utils";
import { TrendingUp, Users, Gauge } from "lucide-react";
import { useLanguage } from "@/views/i18n/LanguageContext";

/* ─── Types ─── */
interface SourceRow {
  source: string;
  count: number;
  won: number;
  conversionRate: number;
  revenue: number;
  quality: { hot: number; warm: number; cold: number; dormant: number; unknown: number };
}
interface Assignment {
  source: string;
  rep_id: string;
  rep_name: string;
  count: number;
}
interface LeadSourcesData {
  isCEO: boolean;
  sources: SourceRow[];
  assignment: Assignment[];
  totals: {
    count: number;
    won: number;
    conversionRate: number;
    quality: Record<string, number>;
  };
}

const SOURCE_COLORS: Record<string, string> = {
  meta_ads: "#3B82F6",
  whatsapp: "#22C55E",
  website: "#8B5CF6",
  offline: "#C48A52",
  referral: "#EC4899",
  other: "#6B7280",
};
const SOURCE_LABEL: Record<string, string> = {
  meta_ads: "Meta Ads",
  whatsapp: "WhatsApp",
  website: "Website",
  offline: "Offline",
  referral: "Referral",
  other: "Other",
};

// Quality → (label, color). Lead quality uses the lead_status taxonomy.
const QUALITY_META: { key: string; labelKey: string; color: string }[] = [
  { key: "hot", labelKey: "analytics.hot", color: "#F43F5E" },
  { key: "warm", labelKey: "analytics.warm", color: "#F59E0B" },
  { key: "cold", labelKey: "analytics.cold", color: "#38BDF8" },
  { key: "dormant", labelKey: "analytics.dormant", color: "#6B7280" },
  { key: "unknown", labelKey: "common.unknown", color: "#475569" },
];

function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v}`;
}

/* ─── Main Component ─── */
export default function LeadSources() {
  const { t } = useLanguage();
  const [data, setData] = useState<LeadSourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/dashboard/lead-sources");
        if (!res.ok) throw new Error("Failed to fetch");
        setData(await res.json());
      } catch (err) {
        setError(t("common.loadFailed"));
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxCount = useMemo(() => {
    if (!data?.sources?.length) return 1;
    return Math.max(...data.sources.map((s) => s.count), 1);
  }, [data]);

  // Assignment grouped by source — MUST stay before early returns (hook order invariant)
  const assignmentBySource = useMemo(() => {
    const map: Record<string, Assignment[]> = {};
    (data?.assignment || []).forEach((a) => {
      (map[a.source] ??= []).push(a);
    });
    return map;
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        {t("analytics.loading")}
      </div>
    );
  }
  if (error) {
    return <div className="flex items-center justify-center h-48 text-rose-400 text-sm">{error}</div>;
  }
  if (!data || data.sources.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        {t("analytics.noData") || "No data"}
      </div>
    );
  }

  const { sources, totals, assignment } = data;
  const totalQuality = (["hot", "warm", "cold", "dormant", "unknown"] as const).reduce(
    (s, k) => s + (totals.quality[k] ?? 0), 0
  ) || 1;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-1 h-4 rounded-full bg-purple-400" />
        <h2 className="text-sm font-semibold text-foreground">{t("analytics.leadSourceAnalysis")}</h2>
        <span className="text-[11px] text-muted-foreground">{totals.count} {t("analytics.totalLeadsLower") || t("analytics.leadsLower")}</span>
      </div>

      {/* Overall quality distribution — stacked div bar */}
      <div className="rounded-xl border border-border/50 bg-card/50 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Gauge className="w-3.5 h-3.5 text-muted-foreground" />
          <h3 className="text-xs font-semibold text-foreground">{t("analytics.qualityDistribution")}</h3>
        </div>
        <div className="flex h-3 rounded-full overflow-hidden bg-muted">
          {QUALITY_META.map((q) => {
            const v = totals.quality[q.key] ?? 0;
            if (v === 0) return null;
            const pct = (v / totalQuality) * 100;
            return (
              <div
                key={q.key}
                title={`${t(q.labelKey)}: ${v} (${Math.round(pct)}%)`}
                className="h-full transition-all duration-500"
                style={{ width: `${pct}%`, background: q.color }}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {QUALITY_META.map((q) => {
            const v = totals.quality[q.key] ?? 0;
            if (v === 0) return null;
            return (
              <span key={q.key} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="w-2 h-2 rounded-full" style={{ background: q.color }} />
                {t(q.labelKey)} <span className="font-medium text-foreground">{v}</span>
              </span>
            );
          })}
        </div>
      </div>

      {/* Per-source conversion funnel */}
      <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 border-b border-border/30 text-[10px] text-muted-foreground uppercase tracking-wider">
          <div className="col-span-3">{t("leads.source")}</div>
          <div className="col-span-2 text-right">{t("analytics.totalLeads")}</div>
          <div className="col-span-2 text-right">{t("analytics.conversion")}</div>
          <div className="col-span-5">{t("analytics.wonAmount")}</div>
        </div>
        <div className="divide-y divide-border/20">
          {sources.map((s) => {
            const widthPct = (s.count / maxCount) * 100;
            const color = SOURCE_COLORS[s.source] || "#6B7280";
            const wonPct = s.count > 0 ? Math.round((s.won / s.count) * 100) : 0;
            const assignReps = assignmentBySource[s.source] ?? [];
            return (
              <div key={s.source} className="px-3 py-2.5 space-y-1.5">
                <div className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-3 flex items-center gap-1.5 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-xs font-medium text-foreground truncate">
                      {SOURCE_LABEL[s.source] || s.source}
                    </span>
                  </div>
                  <div className="col-span-2 text-right text-xs text-foreground">
                    {s.count}
                    <span className="text-[10px] text-emerald-400 ml-1">{s.won}✓</span>
                  </div>
                  <div className="col-span-2 text-right">
                    <span className={cn(
                      "text-xs font-mono font-semibold",
                      s.conversionRate >= (totals.conversionRate ?? 0) ? "text-emerald-400" : "text-amber-400"
                    )}>
                      {s.conversionRate}%
                    </span>
                  </div>
                  <div className="col-span-5 flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      {/* count bar, with won portion highlighted */}
                      <div className="h-full transition-all duration-500 relative" style={{ width: `${Math.max(widthPct, 2)}%`, background: `${color}55` }}>
                        <div className="absolute inset-y-0 left-0" style={{ width: `${wonPct}%`, background: color }} />
                      </div>
                    </div>
                    <span className="text-xs font-medium text-foreground min-w-[70px] text-right">{fmtAED(s.revenue)}</span>
                  </div>
                </div>

                {/* Sales assignment for this source (top 3 reps) */}
                {assignReps.length > 0 && (
                  <div className="flex items-center gap-2 pl-3.5">
                    <Users className="w-3 h-3 text-muted-foreground" />
                    <div className="flex flex-wrap gap-1">
                      {assignReps.slice(0, 3).map((a) => (
                        <span key={a.rep_id} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {a.rep_name} · {a.count}
                        </span>
                      ))}
                      {assignReps.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{assignReps.length - 3}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Best converting source callout */}
      {(() => {
        const best = [...sources].filter((s) => s.count >= 3).sort((a, b) => b.conversionRate - a.conversionRate)[0];
        if (!best) return null;
        return (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1">
            <TrendingUp className="w-3 h-3 text-emerald-400" />
            {t("analytics.bestSource")}{" "}
            <span className="font-semibold text-foreground">{SOURCE_LABEL[best.source] || best.source}</span>{" "}
            ({best.conversionRate}% {t("analytics.conversion")})
          </div>
        );
      })()}
    </div>
  );
}
