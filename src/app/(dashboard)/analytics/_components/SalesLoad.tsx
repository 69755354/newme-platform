"use client";

import { useEffect, useState, useCallback } from "react";
import { useUserRole } from "@/hooks/useUserRole";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import {
  Users, DollarSign, TrendingUp, Activity,
  AlertTriangle, RefreshCw, BarChart3,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

/* ─── Types ─── */
interface RepStat {
  id: string;
  name: string;
  email: string;
  role: string;
  totalLeads: number;
  wonAmount: number;
  wonLeads: number;
  conversionRate: number;
  followupRate: number;
  stageDistribution: Record<string, number>;
  overdueCount: number;
  transferableLeads: { id: string }[];
}

interface SalesLoadData {
  repStats: RepStat[];
  avgLoad: number;
  imbalanceDetected: boolean;
  overloaded: { id: string; name: string; totalLeads: number }[];
  underloaded: { id: string; name: string; totalLeads: number }[];
  isCEO: boolean;
}

interface SalesMyData {
  totalLeads: number;
  stageDistribution: Record<string, number>;
  followupRate: number;
  overdueCount: number;
  isCEO: false;
}

/* ─── Helpers ─── */
function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

const STAGE_KEYS: string[] = [
  "new", "contacted", "requirement_confirmed", "solution_submitted",
  "quotation_submitted", "negotiation", "pending_decision", "won", "lost",
];

const STAGE_I18N_KEYS: Record<string, string> = {
  new: "pipeline.stageNew",
  contacted: "pipeline.stageContacted",
  requirement_confirmed: "pipeline.stageReqConfirmed",
  solution_submitted: "pipeline.stageSolutionSub",
  quotation_submitted: "pipeline.stageQuotationSub",
  negotiation: "pipeline.stageNegotiation",
  pending_decision: "pipeline.stagePendingDecision",
  won: "pipeline.stageWon",
  lost: "pipeline.stageLost",
};

const STAGE_COLORS: Record<string, string> = {
  new: "bg-gray-500/20 text-gray-300",
  contacted: "bg-amber-500/20 text-amber-300",
  requirement_confirmed: "bg-yellow-500/20 text-yellow-300",
  solution_submitted: "bg-pink-500/20 text-pink-300",
  quotation_submitted: "bg-purple-500/20 text-purple-300",
  negotiation: "bg-blue-500/20 text-blue-300",
  pending_decision: "bg-orange-500/20 text-orange-300",
  won: "bg-green-500/20 text-green-300",
  lost: "bg-gray-500/20 text-gray-400",
};

/* ─── Stat Card ─── */
function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex items-start gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${color || "bg-wine-500/10"}`}>
        <Icon className={`w-5 h-5 ${color ? "text-white" : "text-wine-500"}`} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-bold text-foreground">{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

/* ─── CEO View ─── */
function CEOSalesLoad({ data, t }: { data: SalesLoadData; t: (path: string) => string }) {
  const [rebalancing, setRebalancing] = useState(false);
  const [rebalMsg, setRebalMsg] = useState<string | null>(null);

  const handleRebalance = useCallback(async () => {
    setRebalancing(true);
    setRebalMsg(null);
    try {
      const res = await fetch("/api/dashboard/sales-load/rebalance", { method: "POST" });
      const result = await res.json();
      setRebalMsg(result.message || `Transferred ${result.transferred} leads`);
      // Reload after 2s
      setTimeout(() => window.location.reload(), 2000);
    } catch {
      setRebalMsg(t('analytics.rebalanceFailed'));
    } finally {
      setRebalancing(false);
    }
  }, []);

  // Chart data
  const chartData = data.repStats.map((r) => ({
    name: r.name?.split(" ")[0] || r.email?.split("@")[0] || "?",
    leads: r.totalLeads,
    wonAmount: r.wonAmount,
    conversionRate: r.conversionRate,
    followupRate: r.followupRate,
  }));

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">⚖️ {t('analytics.salesLoad')}</h2>

      {/* Imbalance warning */}
      {data.imbalanceDetected && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-300">{t('analytics.loadImbalanceDetected')}</p>
            <p className="text-xs text-muted-foreground">
              {data.overloaded.map((r) => r.name).join(", ")} {t('analytics.overloaded').toLowerCase()} ({data.overloaded[0]?.totalLeads ?? 0} {t('analytics.leadsLower')} vs {t('analytics.avgLoad')} {data.avgLoad}).
              {data.underloaded.length} {t('analytics.underloaded').toLowerCase()} {t('analytics.reps')} {t('common.available')}).
            </p>
          </div>
          <button
            onClick={handleRebalance}
            disabled={rebalancing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 text-xs font-medium hover:bg-amber-500/30 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${rebalancing ? "animate-spin" : ""}`} />
            {rebalancing ? t('analytics.rebalancing') : t('analytics.rebalance')}
          </button>
        </div>
      )}
      {rebalMsg && (
        <div className="p-2 rounded bg-emerald-500/10 text-emerald-300 text-xs">
          {rebalMsg}
        </div>
      )}

      {/* Bar chart */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('analytics.leadDistribution')}</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 20, left: 60, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                width={55}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Bar dataKey="leads" fill="hsl(327, 100%, 45%)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Rep stats table */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('analytics.repDetails')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-2 pr-2 font-medium">{t('analytics.rep')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('analytics.leads')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('analytics.wonAmount')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('analytics.convRateLabel')}</th>
                <th className="text-right py-2 px-2 font-medium">{t('analytics.followupRateLabel')}</th>
                <th className="text-right py-2 pl-2 font-medium">{t('analytics.overdueShort')}</th>
              </tr>
            </thead>
            <tbody>
              {data.repStats.map((rep) => (
                <tr key={rep.id} className="border-b border-border/50 hover:bg-accent/50 transition-colors">
                  <td className="py-2.5 pr-2 font-medium text-foreground">{rep.name || rep.email}</td>
                  <td className="py-2 px-2 text-right font-mono">{rep.totalLeads}</td>
                  <td className="py-2 px-2 text-right font-mono text-emerald-400">{fmtAED(rep.wonAmount)}</td>
                  <td className="py-2 px-2 text-right font-mono">{rep.conversionRate}%</td>
                  <td className="py-2 px-2 text-right font-mono">{rep.followupRate}%</td>
                  <td className={`py-2 pl-2 text-right font-mono ${rep.overdueCount > 0 ? "text-rose-400" : "text-muted-foreground"}`}>
                    {rep.overdueCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ─── Sales View ─── */
function SalesView({ data, t }: { data: SalesMyData; t: (path: string) => string }) {
  const stageEntries = Object.entries(data.stageDistribution).sort();

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">⚖️ {t('analytics.mySalesLoad')}</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Users}
          label={t('analytics.myLeads')}
          value={data.totalLeads}
          color="bg-wine-500/10"
        />
        <StatCard
          icon={Activity}
          label={t('analytics.followupRate')}
          value={`${data.followupRate}%`}
          color="bg-emerald-500/10"
        />
        <StatCard
          icon={AlertTriangle}
          label={t('analytics.overdue')}
          value={data.overdueCount}
          color="bg-rose-500/10"
        />
        <StatCard
          icon={BarChart3}
          label={t('analytics.stages')}
          value={stageEntries.length}
          color="bg-blue-500/10"
        />
      </div>

      {/* Stage distribution */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('analytics.stageDistribution')}</h3>
        <div className="flex flex-wrap gap-2">
          {stageEntries.map(([stage, count]) => (
            <div key={stage} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent">
              <span className={`w-2 h-2 rounded-full ${STAGE_COLORS[stage]?.split(" ")[0] || "bg-gray-500"}`} />
              <span className="text-xs text-muted-foreground">{t(STAGE_I18N_KEYS[stage] || `stages.${stage}`)}</span>
              <span className="text-xs font-bold text-foreground">{count}</span>
            </div>
          ))}
          {stageEntries.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('analytics.noLeadsAssigned')}</p>
          )}
        </div>

        {/* Mini bar chart for stage distribution */}
        {stageEntries.length > 0 && (
          <div className="mt-3 h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stageEntries.map(([stage, count]) => ({ stage: t(STAGE_I18N_KEYS[stage] || `stages.${stage}`), count }))} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="stage" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Bar dataKey="count" fill="hsl(327, 100%, 45%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main Component ─── */
export default function SalesLoad() {
  const { isCEO } = useUserRole();
  const { t } = useLanguage();
  const [data, setData] = useState<SalesLoadData | SalesMyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/sales-load")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-5 bg-accent rounded w-1/3" />
          <div className="h-48 bg-accent rounded" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-card border border-border rounded-xl p-6">
        <p className="text-sm text-rose-400">{t('common.loadFailed')}: {error || t('analytics.noData')}</p>
      </div>
    );
  }

  if (isCEO && "repStats" in data) {
    return <CEOSalesLoad data={data as SalesLoadData} t={t} />;
  }

  if (!isCEO && "followupRate" in data) {
    return <SalesView data={data as SalesMyData} t={t} />;
  }

  return (
    <div className="bg-card border border-border rounded-xl p-6">
      <p className="text-sm text-muted-foreground">{t('analytics.noSalesLoadData')}</p>
    </div>
  );
}
