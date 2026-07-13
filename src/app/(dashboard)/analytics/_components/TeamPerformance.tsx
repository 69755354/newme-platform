"use client";

// DEPRECATED — replaced by dashboard Sales Leaderboard

import { useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Trophy, TrendingUp, Users, Target } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

/* ─── Types ─── */
interface RepStat {
  id: string;
  name: string;
  role: string;
  totalLeads: number;
  wonLeads: number;
  activeLeads: number;
  revenue: number;
  conversionRate: number;
  avgDealSize: number;
}

interface TeamTotal {
  totalLeads: number;
  wonLeads: number;
  revenue: number;
  conversionRate: number;
  avgDealSize: number;
  avgLeads: number;
  avgRevenue: number;
  activeReps: number;
}

interface SourceStat {
  source: string;
  count: number;
  won: number;
  revenue: number;
}

interface TeamPerfData {
  isCEO: boolean;
  repStats: RepStat[];
  team: TeamTotal | null;
  sources: SourceStat[];
}

const SOURCE_COLORS: Record<string, string> = {
  ins: "#E1306C",
  fb: "#1877F2",
  show_room: "#B87333",
  whatsapp: "#22C55E",
  website: "#8B5CF6",
  offline: "#C48A52",
  referral: "#EC4899",
  other: "#6B7280",
};

const SOURCE_LABEL: Record<string, string> = {
  ins: "ins",
  fb: "fb",
  show_room: "show_room",
  whatsapp: "WhatsApp",
  website: "Website",
  offline: "Offline",
  referral: "Referral",
  other: "Other",
};

function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v}`;
}

/* ─── Main Component ─── */
export default function TeamPerformance() {
  const { t } = useLanguage();
  const [data, setData] = useState<TeamPerfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/dashboard/team-performance");
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

  const maxRevenue = useMemo(() => {
    if (!data?.repStats?.length) return 1;
    return Math.max(...data.repStats.map((r) => r.revenue), 1);
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
  if (!data || data.repStats.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        {t("analytics.noData") || "No data"}
      </div>
    );
  }

  const { repStats, team, sources, isCEO } = data;
  const totalSourceCount = sources.reduce((s, x) => s + x.count, 0) || 1;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-1 h-4 rounded-full bg-copper-400" />
        <h2 className="text-sm font-semibold text-foreground">
          {isCEO ? t("analytics.teamPerformance") : t("analytics.myPerformance")}
        </h2>
      </div>

      {/* Team summary cards (management only) */}
      {isCEO && team && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryCard icon={<Trophy className="w-3.5 h-3.5" />} label={t("analytics.wonAmount")} value={fmtAED(team.revenue)} tint="text-copper-400" />
          <SummaryCard icon={<Users className="w-3.5 h-3.5" />} label={t("analytics.totalLeads")} value={String(team.totalLeads)} tint="text-blue-400" />
          <SummaryCard icon={<Target className="w-3.5 h-3.5" />} label={t("analytics.conversionRate")} value={`${team.conversionRate}%`} tint="text-emerald-400" />
          <SummaryCard icon={<TrendingUp className="w-3.5 h-3.5" />} label={t("analytics.avgDealSize")} value={fmtAED(team.avgDealSize)} tint="text-purple-400" />
        </div>
      )}

      {/* Per-salesperson table with revenue bars */}
      <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 border-b border-border/30 text-[10px] text-muted-foreground uppercase tracking-wider">
          <div className="col-span-3">{t("analytics.salesperson") || t("team.title")}</div>
          <div className="col-span-2 text-right">{t("analytics.totalLeads")}</div>
          <div className="col-span-2 text-right">{t("analytics.conversionRate")}</div>
          <div className="col-span-5">{t("analytics.wonAmount")}</div>
        </div>

        <div className="divide-y divide-border/20">
          {repStats.map((rep, idx) => {
            const widthPct = (rep.revenue / maxRevenue) * 100;
            const vsAvg = team ? rep.revenue - team.avgRevenue : 0;
            const isTop = idx === 0 && rep.revenue > 0;
            return (
              <div key={rep.id} className="grid grid-cols-12 gap-2 px-3 py-2.5 items-center">
                <div className="col-span-3 flex items-center gap-1.5 min-w-0">
                  {isTop && <Trophy className="w-3 h-3 text-amber-400 shrink-0" />}
                  <span className="text-xs font-medium text-foreground truncate">{rep.name}</span>
                </div>
                <div className="col-span-2 text-right text-xs text-foreground">
                  {rep.totalLeads}
                  <span className="text-[10px] text-muted-foreground ml-1">({rep.wonLeads}✓)</span>
                </div>
                <div className="col-span-2 text-right">
                  <span className={cn(
                    "text-xs font-mono font-semibold",
                    rep.conversionRate >= (team?.conversionRate ?? 0) ? "text-emerald-400" : "text-amber-400"
                  )}>
                    {rep.conversionRate}%
                  </span>
                </div>
                <div className="col-span-5 space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn("h-full transition-all duration-500", isTop ? "bg-gradient-to-r from-amber-400 to-copper-400" : "bg-gradient-to-r from-copper-500 to-copper-400")}
                        style={{ width: `${Math.max(widthPct, 2)}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-foreground min-w-[70px] text-right">{fmtAED(rep.revenue)}</span>
                  </div>
                  {isCEO && team && (
                    <div className="text-[10px] text-muted-foreground">
                      {vsAvg >= 0 ? "▲" : "▼"} {fmtAED(Math.abs(vsAvg))} {vsAvg >= 0 ? t("analytics.aboveAvg") : t("analytics.belowAvg")}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Lead source breakdown (count per source) */}
      {sources.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-1 h-4 rounded-full bg-blue-400" />
            <h3 className="text-xs font-semibold text-foreground">{t("analytics.sourceBreakdown")}</h3>
          </div>
          <div className="space-y-1.5">
            {sources.map((s) => {
              const pct = Math.round((s.count / totalSourceCount) * 100);
              const color = SOURCE_COLORS[s.source] || "#6B7280";
              return (
                <div key={s.source} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground min-w-[80px] shrink-0">
                    {SOURCE_LABEL[s.source] || s.source}
                  </span>
                  <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
                  </div>
                  <span className="text-xs font-medium text-foreground min-w-[60px] text-right">{s.count} ({pct}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, tint }: {
  icon: React.ReactNode; label: string; value: string; tint: string;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-3">
      <p className={cn("text-[11px] flex items-center gap-1", tint)}>
        {icon}{label}
      </p>
      <p className="text-lg font-bold text-foreground mt-1">{value}</p>
    </div>
  );
}
