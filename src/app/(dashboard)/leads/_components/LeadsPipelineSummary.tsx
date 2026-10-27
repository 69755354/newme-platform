"use client";

/**
 * LeadsPipelineSummary — T3-3 step 13 extracted from leads/page.tsx (was L256-277)
 *
 * The 9-stage clickable summary strip rendered above the kanban board. Each
 * tile shows the per-stage lead count, total AED value, and a percentage bar
 * sized against the busiest stage. Clicking a tile toggles `stageFilter`
 * (same value re-clicks back to "all"), which is mirrored back into the
 * kanban below.
 *
 * Pure presentational — receives:
 *   - `stages`        — the 9 PIPELINE_STAGES constant (icon/color/bg)
 *   - `stageTotals`   — pre-computed Record<stageKey, {count, value}> from
 *                       the page (via useLeadsFiltering)
 *   - `stageFilter`   — current stage key or "all"
 *   - `onStageFilterChange` — setter (we pass the toggled value up)
 *
 * Why split this out?
 *   - The summary grid is 70+ lines of nested JSX (per-stage button, label,
 *     count chip, AED total, percentage bar). Living in page.tsx it makes
 *     the page hard to scan.
 *   - Behavioural contract: 100% byte-identical DOM to the inline version.
 *     Same Tailwind classes, same `cn("...", stageFilter === s.key && ...)`
 *     conditional, same `Math.min(... Math.max(1, ...Object.values(...)))`
 *     bar width math, same data-sticky-region parent living above us.
 *   - The page still owns showPipelineSummary gate and the surrounding
 *     sticky filter-bar wrapper — those control all summary-like regions,
 *     not just this one.
 */

import { cn } from "@/lib/utils";
import { fmtAED } from "../_utils/format";

type StageTotal = { count: number; value: number };

export type PipelineStage = {
  key: string;
  label: string;
  color: string;
  bg: string;
  border: string;
};

type Props = {
  stages: readonly PipelineStage[];
  stageTotals: Record<string, StageTotal>;
  stageFilter: string;
  onStageFilterChange: (next: string) => void;
  t: (key: string) => string;
};

export function LeadsPipelineSummary({
  stages,
  stageTotals,
  stageFilter,
  onStageFilterChange,
  t,
}: Props) {
  return (
    <div data-newme-uat-sensitive="true" className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-1.5">
      {stages.map((s) => {
        const totals = stageTotals[s.key];
        return (
          <button
            key={s.key}
            onClick={() => onStageFilterChange(stageFilter === s.key ? "all" : s.key)}
            className={cn(
              "text-left p-2 rounded-lg border transition-all",
              stageFilter === s.key ? "ring-2 ring-offset-1 ring-offset-background" : "",
              s.bg,
              s.border
            )}
          >
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] font-medium text-muted-foreground truncate">
                {t(`stageLabels.${s.key}`)}
              </span>
              <span className="text-xs font-bold text-foreground ml-1">
                {totals.count}
              </span>
            </div>
            <div className="text-right mb-1">
              <span className="text-[9px] text-muted-foreground">
                {totals.value > 0 ? fmtAED(totals.value) : "—"}
              </span>
            </div>
            <div className="h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(
                    (totals.count /
                      Math.max(
                        1,
                        ...Object.values(stageTotals).map((x) => x.count)
                      )) *
                      100,
                    100
                  )}%`,
                  backgroundColor: s.color,
                }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}
