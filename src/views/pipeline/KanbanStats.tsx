"use client";

/**
 * KanbanStats — T2-2 unified visual unit
 *
 * Replaces the previously scattered "stage label + percentage + count + bar + value"
 * block (5 separate elements per stage) with a SINGLE visual unit per stage.
 *
 * Reusable across pipeline page (top stats strip) and future dashboard / quota pages.
 *
 * Usage:
 *   import KanbanStats from "@/views/pipeline/KanbanStats";
 *   <KanbanStats leads={leads} onStageClick={(k) => scrollTo(k)} />
 */

import { useMemo, useCallback } from "react";
import { useLanguage } from "@/views/i18n/LanguageContext";
import { cn } from "@/models/utils";

/* ─── Lead shape (subset used by this component) ─── */
export interface KanbanStatsLead {
  id: string;
  stage: string;
  final_status: string | null;
  quotation_value: number | null;
}

/* ─── Stage definition (kept self-contained for reusability) ─── */
export interface KanbanStageDef {
  key: string;
  labelKey: string;
  color: string;
  bg: string;
  border: string;
}

export const DEFAULT_KANBAN_STAGES: KanbanStageDef[] = [
  { key: "new",                    labelKey: "pipeline.stageNew",              color: "#6B7280", bg: "bg-muted/30",         border: "border-border/40" },
  { key: "contacted",              labelKey: "pipeline.stageContacted",        color: "#C48A52", bg: "bg-amber-950/30",     border: "border-amber-800/40" },
  { key: "requirement_confirmed",  labelKey: "pipeline.stageReqConfirmed",     color: "#E0B95A", bg: "bg-yellow-950/20",    border: "border-yellow-800/40" },
  { key: "solution_submitted",     labelKey: "pipeline.stageSolutionSub",      color: "#4A5568", bg: "bg-slate-950/20",     border: "border-slate-800/40" },
  { key: "quotation_submitted",    labelKey: "pipeline.stageQuotationSub",     color: "#8B5CF6", bg: "bg-purple-950/20",    border: "border-purple-800/40" },
  { key: "negotiation",            labelKey: "pipeline.stageNegotiation",      color: "#3B82F6", bg: "bg-blue-950/20",      border: "border-blue-800/40" },
  { key: "pending_decision",       labelKey: "pipeline.stagePendingDecision",  color: "#F59E0B", bg: "bg-amber-950/20",     border: "border-amber-800/40" },
  { key: "won",                    labelKey: "pipeline.stageWon",              color: "#4ADE80", bg: "bg-emerald-950/20",   border: "border-emerald-800/40" },
  { key: "lost",                   labelKey: "pipeline.stageLost",             color: "#6B7280", bg: "bg-muted/30",         border: "border-border/40" },
];

/* ─── Currency helper (re-exported for callers) ─── */
export function formatAEDShort(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

/* ─── Component ─── */
export interface KanbanStatsProps {
  leads: KanbanStatsLead[];
  /** Override default stage definitions (e.g. dashboard / quota views) */
  stages?: KanbanStageDef[];
  /** Optional click handler per stage pill — defaults to scrolling `#stage-{key}` into view */
  onStageClick?: (stageKey: string) => void;
  /** Currently active stage (for ring highlight) */
  activeStageKey?: string | null;
  /** Optional extra className for the outer grid */
  className?: string;
}

export default function KanbanStats({
  leads,
  stages = DEFAULT_KANBAN_STAGES,
  onStageClick,
  activeStageKey = null,
  className,
}: KanbanStatsProps) {
  const { t } = useLanguage();

  // Group leads into columns by stage (won/lost read from final_status for dual-source)
  const columns = useMemo(() => {
    const g: Record<string, KanbanStatsLead[]> = {};
    for (const s of stages) g[s.key] = [];
    for (const l of leads) {
      const key = l.final_status || l.stage;
      if (g[key]) g[key].push(l);
    }
    return g;
  }, [leads, stages]);

  // Denominators: terminal stages (won/lost) use totalAll to avoid >100% overflow;
  // active stages use totalActive.
  const totalAll = leads.length;
  const totalActive = useMemo(
    () =>
      stages
        .filter((s) => s.key !== "won" && s.key !== "lost")
        .reduce((sum, s) => sum + (columns[s.key]?.length || 0), 0),
    [columns, stages]
  );

  const handleClick = useCallback(
    (key: string) => {
      if (onStageClick) return onStageClick(key);
      // Fallback: scroll to the kanban column
      const el = document.getElementById(`stage-${key}`);
      if (el) el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    },
    [onStageClick]
  );

  return (
    <div
      role="region"
      aria-label="Pipeline stage distribution"
      className={cn(
        // Single grid container — treats the whole strip as one visual unit
        "rounded-xl border border-border/40 bg-card/30 p-2",
        className
      )}
    >
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-1.5">
        {stages.map((s) => {
          const items = columns[s.key] || [];
          const value = items.reduce((sum, l) => sum + (l.quotation_value || 0), 0);
          const isTerminal = s.key === "won" || s.key === "lost";
          const denominator = isTerminal ? totalAll : totalActive;
          const pct = denominator > 0 ? Math.round((items.length / denominator) * 100) : 0;
          const isActive = activeStageKey === s.key;

          // ─── SINGLE VISUAL UNIT per stage pill ───
          // All five data points (label, pct, count, bar, value) live inside
          // ONE rounded card so the stats strip reads as one cohesive unit,
          // not 5×9 = 45 separate elements.
          return (
            <button
              type="button"
              key={s.key}
              onClick={() => handleClick(s.key)}
              aria-label={`${t(s.labelKey)} — ${items.length} leads, ${pct}%`}
              className={cn(
                "text-left p-2 rounded-lg border transition-all cursor-pointer hover:border-copper-500/50",
                s.bg,
                s.border,
                isActive && "ring-2 ring-copper-500/60"
              )}
            >
              {/* Row 1: label + percent — same baseline */}
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] font-medium text-muted-foreground truncate">
                  {t(s.labelKey)}
                </span>
                <span className="text-[9px] text-muted-foreground/70 tabular-nums">{pct}%</span>
              </div>

              {/* Row 2: count number — the headline metric */}
              <span className="text-sm font-bold text-foreground tabular-nums">{items.length}</span>

              {/* Row 3: progress bar — visual filler */}
              <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-1">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${pct}%`, backgroundColor: s.color }}
                />
              </div>

              {/* Row 4: value — optional caption, stays inside the unit */}
              {value > 0 && (
                <p className="text-[9px] text-muted-foreground mt-0.5 tabular-nums">{formatAEDShort(value)}</p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}