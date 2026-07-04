"use client";

import { useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { AlertTriangle, Users, Clock, ChevronRight, TrendingDown } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";

/* ─── Types ─── */
interface StageData {
  key: string;
  label: string;
  count: number;
  pctOfTop: number;
  conversionToNext: number | null;
  avgDaysInStage: number;
  isBottleneck: boolean;
}

interface FunnelData {
  stages: StageData[];
  totalLeads: number;
  stuckLeads: { id: string; customer_name: string | null; days_in_stage: number; stage_label: string }[];
  lostFromStage: Record<string, number>;
}

/* ─── Helpers ─── */
function fmtPct(v: number): string {
  return `${Math.round(v)}%`;
}

function fmtDays(v: number): string {
  if (v >= 365) return `${Math.round(v / 30)}mo`;
  return `${v}d`;
}

/* ─── Components ─── */
function FunnelBar({
  stage,
  maxCount,
  showConversion = true,
}: {
  stage: StageData;
  maxCount: number;
  showConversion?: boolean;
}) {
  const pct = maxCount > 0 ? (stage.count / maxCount) * 100 : 0;
  const isLost = stage.key === "lost";
  const barColor = isLost
    ? "bg-gray-500/30"
    : stage.isBottleneck
      ? "bg-rose-500/50"
      : "bg-copper-400/60";

  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[11px] font-medium text-foreground truncate">
            {stage.label}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {stage.count}
          </span>
          {stage.isBottleneck && !isLost && (
            <TrendingDown className="w-3 h-3 text-rose-400 shrink-0" />
          )}
        </div>
        <div className="w-full h-2 rounded-full bg-muted/20 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
      </div>
      {showConversion && (
        <div className="min-w-[60px] text-right">
          <span className="text-[10px] text-muted-foreground">
            {stage.conversionToNext !== null ? fmtPct(stage.conversionToNext) : "—"}
          </span>
        </div>
      )}
      <div className="min-w-[40px] text-right">
        <span className="text-[10px] text-muted-foreground">{fmtDays(stage.avgDaysInStage)}</span>
      </div>
    </div>
  );
}

/* ─── Main Component ─── */
export default function PipelineFunnel() {
  const router = useRouter();
  const { t } = useLanguage();
  const { loading: roleLoading, role } = useRequireRole(["admin", "boss", "operator", "sales"]);

  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const userRole = roleLoading ? null : role;

  useEffect(() => {
    if (!userRole) return;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/dashboard/pipeline-funnel");
        if (!res.ok) throw new Error("Failed to fetch");
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(t("common.loadFailed"));
        console.error(err);
      }
      setLoading(false);
    })();
  }, [userRole]);

  const isManagement = userRole === "admin" || userRole === "boss" || userRole === "operator";
  const maxCount = useMemo(() => {
    if (!data?.stages) return 1;
    return Math.max(...data.stages.map(s => s.count), 1);
  }, [data]);

  // Bottleneck stage
  const bottleneck = useMemo(() => {
    return data?.stages.find(s => s.isBottleneck);
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        {t("analytics.loadingFunnel")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-48 text-rose-400 text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 rounded-full bg-copper-400" />
          <h2 className="text-sm font-semibold text-foreground">
            {isManagement ? t("analytics.pipelineFunnel") : `${t("analytics.myLeads")} ${t("analytics.pipelineFunnel")}`}
          </h2>
          {data && (
            <span className="text-[11px] text-muted-foreground">
              {data.totalLeads} {t("analytics.totalLeadsLower") || t("analytics.leadsLower")}
            </span>
          )}
        </div>
        {bottleneck && (
          <div className="flex items-center gap-1 text-[11px] text-red-400">
            <AlertTriangle className="w-3 h-3" />
            {t("analytics.bottleneck")} "{bottleneck.label}"
          </div>
        )}
      </div>

      {/* Funnel visualization */}
      <div className="rounded-xl border border-border/50 bg-card/50 p-3 space-y-0.5">
        {/* Column headers */}
        <div className="flex items-center gap-3 pb-2 mb-1 border-b border-border/30 text-[10px] text-muted-foreground uppercase tracking-wider">
          <div className="flex-1">{t("analytics.stage")}</div>
          <div className="min-w-[60px] text-right">{t("analytics.conv")}</div>
          <div className="min-w-[40px] text-right">{t("analytics.avg")}</div>
        </div>

        {/* Funnel bars */}
        {data?.stages.filter(s => s.key !== "lost").map((stage) => (
          <FunnelBar
            key={stage.key}
            stage={stage}
            maxCount={maxCount}
            showConversion={true}
          />
        ))}
      </div>

      {/* Legend: lost stage small */}
      {data?.stages.find(s => s.key === "lost") && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-3">
          <span className="text-gray-400">{t("analytics.lostColon")}</span>
          <span className="font-semibold">{data.stages.find(s => s.key === "lost")?.count || 0}</span>
        </div>
      )}

      {/* Stuck leads section */}
      {data?.stuckLeads && data.stuckLeads.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-1 h-4 rounded-full bg-amber-500" />
            <h3 className="text-xs font-semibold text-foreground">{t("analytics.stuckLeads")}</h3>
            <span className="text-[10px] text-muted-foreground">
              ({data.stuckLeads.length})
            </span>
          </div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {data.stuckLeads.slice(0, 5).map((lead) => (
              <button
                key={lead.id}
                onClick={() => router.push(`/leads/${lead.id}`)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-accent/30 transition-colors text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Users className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium truncate">
                    {lead.customer_name || t("analytics.unnamed")}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    ({lead.stage_label})
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Clock className="w-2.5 h-2.5 text-amber-400" />
                  <span className="text-[10px] text-amber-400 font-medium">
                    {lead.days_in_stage}d
                  </span>
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                </div>
              </button>
            ))}
            {data.stuckLeads.length > 5 && (
              <p className="text-[10px] text-muted-foreground text-center pt-1">
                +{data.stuckLeads.length - 5} {t("analytics.more")}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Where I lose most (Sales view) */}
      {!isManagement && data?.lostFromStage && Object.keys(data.lostFromStage).length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-1 h-4 rounded-full bg-red-500" />
            <h3 className="text-xs font-semibold text-foreground">{t("analytics.whereILoseMost")}</h3>
          </div>
          <div className="space-y-1">
            {Object.entries(data.lostFromStage)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 3)
              .map(([stageKey, count]) => {
                const stageLabel = data.stages.find(s => s.key === stageKey)?.label || stageKey;
                return (
                  <div key={stageKey} className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-red-500/5 border border-red-500/10">
                    <span className="text-xs text-muted-foreground">{stageLabel}</span>
                    <span className="text-xs font-medium text-red-400">{count} {t("analytics.lost")}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
