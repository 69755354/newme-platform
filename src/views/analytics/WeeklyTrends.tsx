"use client";

import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { cn } from "@/models/utils";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { useLanguage } from "@/views/i18n/LanguageContext";

/* ─── Types ─── */
interface WeekData {
  year: number;
  week: number;
  start_date: string;
  end_date: string;
  new_leads: number;
  signed_amount: number;
  conversion_rate: number;
  collected_amount: number;
}

interface WoWChange {
  change_pct: number | null;
  direction: "up" | "down" | "flat";
}

interface WoWComparison {
  new_leads: WoWChange;
  signed_amount: WoWChange;
  conversion_rate: WoWChange;
  collected_amount: WoWChange;
}

interface WeeklyTrendsData {
  weeks: WeekData[];
  wow_comparison: WoWComparison;
}

function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toFixed(0)}`;
}

/* ─── Chart colors ─── */
const COLORS = {
  leads: "#4A5568",
  signed: "#8B5CF6",
  conversion: "#4ADE80",
  collected: "#3B82F6",
};

/* ─── WoW Badge ─── */
function WoWBadge({ change, t }: { change: WoWChange; t: (path: string) => string }) {
  if (change.change_pct === null || change.change_pct === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="w-3 h-3" /> {t("analytics.flat")}
      </span>
    );
  }

  const isUp = change.direction === "up";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        isUp ? "text-emerald-400" : "text-rose-400"
      )}
    >
      {isUp ? (
        <ArrowUp className="w-3 h-3" />
      ) : (
        <ArrowDown className="w-3 h-3" />
      )}
      {change.change_pct.toFixed(1)}%
    </span>
  );
}

/* ─── Main Component ─── */
interface WeeklyTrendsProps {
  isManagement?: boolean;
}

export default function WeeklyTrends({ isManagement = true }: WeeklyTrendsProps) {
  const { t } = useLanguage();
  const [data, setData] = useState<WeeklyTrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/dashboard/weekly-trends");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
        {t("analytics.loadingTrends")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-8 text-center text-sm text-rose-400">
        {t("common.loadFailed")}: {error}
      </div>
    );
  }

  if (!data || !data.weeks || data.weeks.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("analytics.noWeeklyData")}
      </div>
    );
  }

  const { weeks, wow_comparison } = data;

  // i18n-aware chart data keys
  const chartData = weeks.map((w) => ({
    label: `W${w.week}`,
    week: w.week,
    [t("analytics.newLeads")]: w.new_leads,
    [t("analytics.signedAmountLabel")]: w.signed_amount,
    [t("analytics.convRateLabel")]: w.conversion_rate,
    [t("analytics.collectedLabel")]: w.collected_amount,
  }));

  return (
    <div className="space-y-4">
      {/* Chart */}
      <div className="rounded-xl border border-border/50 bg-card/50 p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">
          {isManagement ? t("analytics.weeklyTrendsChart") : t("analytics.myWeeklyTrends")}
        </h3>

        {/* New Leads (Bar) + Signed Amount (Line) */}
        <div className="h-64 mb-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                domain={[0, "auto"]}
              />
              <Tooltip />
              <Legend
                wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
                iconSize={8}
              />
              <Bar
                yAxisId="left"
                dataKey={t("analytics.newLeads")}
                fill={COLORS.leads}
                radius={[3, 3, 0, 0]}
                maxBarSize={24}
                opacity={0.85}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={t("analytics.signedAmountLabel")}
                stroke={COLORS.signed}
                strokeWidth={2}
                dot={{ r: 3, fill: COLORS.signed }}
                activeDot={{ r: 5 }}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={t("analytics.convRateLabel")}
                stroke={COLORS.conversion}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={{ r: 3, fill: COLORS.conversion }}
                activeDot={{ r: 5 }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* WoW Comparison Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            { label: t("analytics.newLeads"), wow: wow_comparison.new_leads, current: weeks[weeks.length - 1].new_leads },
            { label: t("analytics.signedAmount"), wow: wow_comparison.signed_amount, current: fmtAED(weeks[weeks.length - 1].signed_amount) },
            { label: t("analytics.convRateLabel"), wow: wow_comparison.conversion_rate, current: `${weeks[weeks.length - 1].conversion_rate}%` },
            { label: t("analytics.collectedLabel"), wow: wow_comparison.collected_amount, current: fmtAED(weeks[weeks.length - 1].collected_amount) },
          ].map((card) => (
            <div
              key={card.label}
              className="p-3 rounded-lg border border-border/50 bg-card/30"
            >
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                {card.label}
              </p>
              <p className="text-sm font-bold text-foreground mt-0.5">
                {card.current}
              </p>
              <WoWBadge change={card.wow} t={t} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
