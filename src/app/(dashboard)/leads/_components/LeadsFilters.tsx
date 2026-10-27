"use client";

/**
 * LeadsFilters — T3-3 step 9 extracted from leads/page.tsx (was L286-366)
 *
 * The single row of filter chips below the pipeline summary bar:
 *   - search input (with clear button)
 *   - stage / source / quality / status / probability selects
 *   - quick-filter pills for the active alert/manager chips
 *     (yellow alert, red alert, recovery, transfer, review, assigned_to)
 *   - follow-up toggle
 *   - "n results" counter on the right
 *
 * 100% behavioural equivalence with the inline JSX that lived in page.tsx:
 *   - the wrapping <div className="flex gap-2 flex-wrap items-center">
 *     moved inside this component; the page renders <LeadsFilters .../> in
 *     its place so DOM is byte-identical
 *   - stage-change handler resets alertFilter to "all" via the parent-
 *     supplied `onStageChange` wrapper (the parent owns the dual-setter)
 *   - assigned-to chip clear also calls router.replace("/leads") — useRouter
 *     lives inside this component, no parent prop
 *   - quick-filter chip colours / icons / t() keys preserved verbatim
 *
 * Why extract this even though it's pure presentational?
 *   - leads/page.tsx is shrinking toward a render-only orchestrator
 *     (page now owns hooks + derived state; child components own their UI
 *     regions)
 *   - 80 lines of props is verbose but mirrors how page-level state already
 *     lives in one place — single source of truth preserved
 *   - the sticky filter row is a coherent UX unit; future tweaks (chip
 *     variants, density, a11y) become local instead of touching 468-line
 *     page.tsx
 *
 * Props are passed-through by design (no internal state). All setters
 * dispatch to the page so existing state remains the single source of
 * truth.
 */

import { useRouter } from "next/navigation";
import { Search, X, Calendar, Users, Clock,
  AlertTriangle, RotateCcw, GripHorizontal, ShieldAlert,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PIPELINE_STAGES, STATUS_EMOJIS, STATUS_LABELS, PROBABILITIES } from "../_utils/constants";
import type { SalesUser } from "../_hooks/useLeadMutations";

/* ─── Props ─── */
export interface LeadsFiltersProps {
  // 8 state + 8 setter pairs
  search: string;
  setSearch: (v: string | ((prev: string) => string)) => void;
  stageFilter: string;
  /** Wrapper that sets stageFilter AND resets alertFilter to "all". */
  onStageChange: (v: string) => void;
  sourceFilter: string;
  setSourceFilter: (v: string | ((prev: string) => string)) => void;
  qualityFilter: string;
  setQualityFilter: (v: string | ((prev: string) => string)) => void;
  statusFilter: string;
  setStatusFilter: (v: string | ((prev: string) => string)) => void;
  probabilityFilter: number | null;
  setProbabilityFilter: (v: number | null | ((prev: number | null) => number | null)) => void;
  followupFilter: boolean;
  setFollowupFilter: (v: boolean | ((prev: boolean) => boolean)) => void;
  alertFilter: string;
  setAlertFilter: (v: string | ((prev: string) => string)) => void;
  recoveryFilter: boolean;
  setRecoveryFilter: (v: boolean | ((prev: boolean) => boolean)) => void;
  transferFilter: boolean;
  setTransferFilter: (v: boolean | ((prev: boolean) => boolean)) => void;
  reviewFilter: boolean;
  setReviewFilter: (v: boolean | ((prev: boolean) => boolean)) => void;
  assignedToFilter: string;
  setAssignedToFilter: (v: string | ((prev: string) => string)) => void;
  // Data
  sources: string[];
  salesUsers: SalesUser[];
  // Derived
  filteredCount: number;
}

/* ─── Component ─── */
export function LeadsFilters({
  search,
  setSearch,
  stageFilter,
  onStageChange,
  sourceFilter,
  setSourceFilter,
  qualityFilter,
  setQualityFilter,
  statusFilter,
  setStatusFilter,
  probabilityFilter,
  setProbabilityFilter,
  followupFilter,
  setFollowupFilter,
  alertFilter,
  setAlertFilter,
  recoveryFilter,
  setRecoveryFilter,
  transferFilter,
  setTransferFilter,
  reviewFilter,
  setReviewFilter,
  assignedToFilter,
  setAssignedToFilter,
  sources,
  salesUsers,
  filteredCount,
}: LeadsFiltersProps) {
  const router = useRouter();
  const { t } = useLanguage();

  return (
    <div className="flex gap-2 flex-wrap items-center">
      <div className="flex flex-1 min-w-[180px] max-w-xs items-center gap-1">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder={t("leads.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9 text-sm" />
        </div>
        {search && (
          <button
            onClick={() => setSearch("")}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            aria-label={t("leads.clear")}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <select value={stageFilter} onChange={(e) => onStageChange(e.target.value)}
        className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[130px]">
        <option value="all">{t("leads.allStages")}</option>
        {PIPELINE_STAGES.map(s => <option key={s.key} value={s.key}>{t(`stageLabels.${s.key}`)}</option>)}
      </select>
      <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
        className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[110px]">
        <option value="all">{t("leads.allSources")}</option>
        {sources.map(src => <option key={src} value={src}>{t(`sourceLabels.${src}`) || src}</option>)}
      </select>
      <select value={qualityFilter} onChange={(e) => setQualityFilter(e.target.value)}
        className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[110px]">
        <option value="all">{t("leads.allQuality")}</option>
        {['good','normal','pending','poor'].map(q => <option key={q} value={q}>{t(`qualityLabels.${q}`)}</option>)}
      </select>
      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
        className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[110px]">
        <option value="all">{t("leads.allStatus")}</option>
        {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{STATUS_EMOJIS[k] || ""} {t(`statusLabels.${k}`)}</option>)}
      </select>
      <select value={probabilityFilter ?? "all"} onChange={(e) => setProbabilityFilter(e.target.value === "all" ? null : parseInt(e.target.value))}
        className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[90px]">
        <option value="all">{t("leads.probability")}</option>
        {PROBABILITIES.map(p => <option key={p} value={p}>{p}%</option>)}
      </select>

      {/* Alert/Manager quick filters */}
      {alertFilter === "yellow" && (
        <button onClick={() => setAlertFilter("all")}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20">
          <Clock className="w-3 h-3" />{t("dashboard.yellowAlerts")} <X className="w-3 h-3" />
        </button>
      )}
      {alertFilter === "red" && (
        <button onClick={() => setAlertFilter("all")}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-rose-500/10 text-rose-400 hover:bg-rose-500/20">
          <AlertTriangle className="w-3 h-3" />{t("dashboard.redAlerts")} <X className="w-3 h-3" />
        </button>
      )}
      {recoveryFilter && (
        <button onClick={() => setRecoveryFilter(false)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-orange-500/10 text-orange-400 hover:bg-orange-500/20">
          <RotateCcw className="w-3 h-3" />{t("leads.recovery")} <X className="w-3 h-3" />
        </button>
      )}
      {transferFilter && (
        <button onClick={() => setTransferFilter(false)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20">
          <GripHorizontal className="w-3 h-3" />{t("leads.transfer")} <X className="w-3 h-3" />
        </button>
      )}
      {reviewFilter && (
        <button onClick={() => setReviewFilter(false)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20">
          <ShieldAlert className="w-3 h-3" />{t("dashboard.managerReview")} <X className="w-3 h-3" />
        </button>
      )}
      {assignedToFilter !== "all" && (
        <button onClick={() => { setAssignedToFilter("all"); router.replace("/leads"); }}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-copper-500/10 text-copper-400 hover:bg-copper-500/20">
          <Users className="w-3 h-3" />{salesUsers.find((u: any) => u.id === assignedToFilter)?.full_name || assignedToFilter} <X className="w-3 h-3" />
        </button>
      )}
      <button onClick={() => setFollowupFilter(!followupFilter)}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors",
          followupFilter
            ? "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
            : "bg-rose-500/10 text-rose-400 hover:bg-rose-500/20"
        )}>
        <Calendar className="w-3 h-3" />{t("leads.needsFollowup")}{followupFilter && <X className="w-3 h-3 ml-0.5" />}
      </button>
      <span className="text-xs text-muted-foreground ml-auto">{t("leads.nResults").replace("{n}", String(filteredCount))}</span>
    </div>
  );
}
