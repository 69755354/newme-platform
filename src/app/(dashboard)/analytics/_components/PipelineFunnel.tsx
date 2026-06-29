"use client";

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { AlertTriangle, Users, Clock, ChevronRight, TrendingDown } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

const supabase = createClient();

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

interface StuckLead {
  id: string;
  customer_name: string | null;
  stage: string;
  days_in_stage: number;
  stage_label: string;
}

interface FunnelData {
  stages: StageData[];
  stuckLeads: StuckLead[];
  totalLeads: number;
  lostFromStage: Record<string, number>;
}

/* ─── Stage color config ─── */
const STAGE_COLORS: Record<string, string> = {
  new: "#6B7280",
  contacted: "#C48A52",
  requirement_confirmed: "#E0B95A",
  solution_submitted: "#4A5568",
  quotation_submitted: "#8B5CF6",
  negotiation: "#3B82F6",
  pending_decision: "#F59E0B",
  won: "#4ADE80",
  lost: "#6B7280",
};

const STAGE_BG: Record<string, string> = {
  new: "bg-gray-500/10",
  contacted: "bg-amber-700/20",
  requirement_confirmed: "bg-yellow-600/20",
  solution_submitted: "bg-slate-700/20",
  quotation_submitted: "bg-purple-600/20",
  negotiation: "bg-blue-600/20",
  pending_decision: "bg-amber-600/20",
  won: "bg-emerald-600/20",
  lost: "bg-gray-500/10",
};

const BORDER_COLORS: Record<string, string> = {
  new: "border-gray-500/30",
  contacted: "border-amber-700/30",
  requirement_confirmed: "border-yellow-600/30",
  solution_submitted: "border-slate-700/30",
  quotation_submitted: "border-purple-600/30",
  negotiation: "border-blue-600/30",
  pending_decision: "border-amber-600/30",
  won: "border-emerald-600/30",
  lost: "border-gray-500/30",
};

function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v}`;
}

/* ─── Funnel Bar ─── */
function FunnelBar({ stage, maxCount, showConversion }: {
  stage: StageData;
  maxCount: number;
  showConversion: boolean;
}) {
  const router = useRouter();
  const widthPct = maxCount > 0 ? Math.max((stage.count / maxCount) * 100, 3) : 0;
  const color = STAGE_COLORS[stage.key] || "#6B7280";

  return (
    <button
      onClick={() => router.push(`/leads?stage=${stage.key}`)}
      className="w-full group relative flex items-center gap-3 py-1.5 hover:opacity-90 transition-all text-left"
    >
      {/* Funnel bar visualization */}
      <div className="flex-1 relative h-11">
        {/* Background bar */}
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-r-lg border transition-all duration-300",
            STAGE_BG[stage.key] || "bg-gray-500/10",
            BORDER_COLORS[stage.key] || "border-gray-500/30",
            stage.isBottleneck && "ring-1 ring-red-400/60"
          )}
          style={{ width: `${widthPct}%` }}
        >
          {/* Filled portion with gradient */}
          <div
            className="absolute inset-0 rounded-r-lg opacity-80"
            style={{
              background: `linear-gradient(90deg, ${color}44, ${color}22)`,
            }}
          />
        </div>

        {/* Label overlay */}
        <div className="absolute inset-0 flex items-center px-3 gap-2 z-10">
          <span className="text-xs font-semibold text-foreground min-w-[100px] shrink-0">
            {stage.label}
          </span>
          <span className="text-sm font-bold text-foreground">
            {stage.count}
          </span>
          {stage.pctOfTop < 100 && (
            <span className="text-[10px] text-muted-foreground">
              ({stage.pctOfTop}%)
            </span>
          )}
        </div>
      </div>

      {/* Conversion rate to next */}
      {showConversion && stage.conversionToNext !== null && (
        <div className={cn(
          "flex items-center gap-1 text-xs font-mono min-w-[60px] justify-end shrink-0",
          stage.isBottleneck ? "text-red-400" : "text-emerald-400"
        )}>
          {stage.isBottleneck && <TrendingDown className="w-3 h-3" />}
          {stage.conversionToNext}%
        </div>
      )}

      {/* Avg days */}
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground min-w-[40px] justify-end shrink-0">
        <Clock className="w-2.5 h-2.5" />
        {stage.avgDaysInStage > 0 ? `${stage.avgDaysInStage}d` : "—"}
      </div>
    </button>
  );
}

/* ─── Main Component ─── */
export default function PipelineFunnel() {
  const router = useRouter();
  const { t } = useLanguage();

  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      setUserRole(profile?.role ?? "sales");
    })();
  }, []);

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
            {t("analytics.bottleneck")} &quot;{bottleneck.label}&quot;
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
