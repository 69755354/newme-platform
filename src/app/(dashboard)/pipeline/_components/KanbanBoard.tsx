"use client";

/**
 * KanbanBoard — T3-3 step 3 extracted from pipeline/page.tsx
 *
 * Full kanban rendering shell for management roles:
 *   - Header (title + showEmpty toggle + Create button + saving/active badges)
 *   - Stage totals bar (delegated to KanbanStats)
 *   - Left/right arrow buttons + horizontally scrollable column container
 *   - 9 stage columns with drag/drop wiring
 *
 * Pure presentational. All data fetching, drag logic, and route handling
 * stay in the parent (pipeline/page.tsx).
 */

import { useMemo, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { cn } from "@/lib/utils";
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import KanbanStats from "@/components/pipeline/KanbanStats";
import { LeadCard } from "./LeadCard";
import type { Lead } from "./LeadCard";

/* ─── Stage definitions (kanban-only; sales KPI dashboard has its own copy) ─── */
const STAGES = [
  { key: "new", labelKey: "pipeline.stageNew", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
  { key: "contacted", labelKey: "pipeline.stageContacted", color: "#C48A52", bg: "bg-amber-950/30", border: "border-amber-800/40" },
  { key: "requirement_confirmed", labelKey: "pipeline.stageReqConfirmed", color: "#E0B95A", bg: "bg-yellow-950/20", border: "border-yellow-800/40" },
  { key: "solution_submitted", labelKey: "pipeline.stageSolutionSub", color: "#4A5568", bg: "bg-slate-950/20", border: "border-slate-800/40" },
  { key: "quotation_submitted", labelKey: "pipeline.stageQuotationSub", color: "#8B5CF6", bg: "bg-purple-950/20", border: "border-purple-800/40" },
  { key: "negotiation", labelKey: "pipeline.stageNegotiation", color: "#3B82F6", bg: "bg-blue-950/20", border: "border-blue-800/40" },
  { key: "pending_decision", labelKey: "pipeline.stagePendingDecision", color: "#F59E0B", bg: "bg-amber-950/20", border: "border-amber-800/40" },
  { key: "won", labelKey: "pipeline.stageWon", color: "#4ADE80", bg: "bg-emerald-950/20", border: "border-emerald-800/40" },
  { key: "lost", labelKey: "pipeline.stageLost", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
];

/* ─── Local helper (rendering-only, no business logic) ─── */
function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

/* ─── Props ─── */
export interface KanbanBoardProps {
  /** Kanban data — group by `final_status` first, fall back to `stage`. */
  leads: Lead[];
  /** Users map for resolving `assigned_to` → full_name on each card. */
  salesUsers: any[];
  /** Ref attached to the horizontal scroll container (used by arrow buttons + keyboard nav in parent). */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Drag state — currently active lead being dragged. */
  draggingLeadId: string | null;
  /** Drag state — stage currently being hovered. */
  draggingOverStage: string | null;
  /** 5 drag/drop callbacks from usePipelineDragDrop — forwarded verbatim. */
  onDragStart: (e: React.DragEvent, leadId: string) => void;
  onDragOver: (e: React.DragEvent, stageKey: string) => void;
  onDragEnter: (stageKey: string) => void;
  onDragLeave: (stageKey: string) => void;
  onDrop: (e: React.DragEvent, targetStage: string) => Promise<void>;
  /** Empty-stage filter toggle. */
  showEmptyStages: boolean;
  onToggleEmptyStages: () => void;
  /** Summary metrics shown in the header subtitle. */
  totalActive: number;
  totalValue: number;
  /** Visual badges in the header — page-level concerns. */
  isSales?: boolean;
  isUpdating?: boolean;
}

/* ─── Component ─── */
export function KanbanBoard({
  leads,
  salesUsers,
  scrollContainerRef,
  draggingLeadId,
  draggingOverStage,
  onDragStart,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  showEmptyStages,
  onToggleEmptyStages,
  totalActive,
  totalValue,
  isSales = false,
  isUpdating = false,
}: KanbanBoardProps) {
  const router = useRouter();
  const { t } = useLanguage();

  // Group leads by stage. won/lost live in final_status; fall back to stage for
  // the dual-source transition window.
  const columns = useMemo(() => {
    const g: Record<string, Lead[]> = {};
    for (const s of STAGES) g[s.key] = [];
    for (const l of leads) {
      const key = l.final_status || l.stage;
      if (g[key]) g[key].push(l);
    }
    return g;
  }, [leads]);

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{t("pipeline.title")}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {t("pipeline.nActive").replace("{n}", String(totalActive))} · {t("pipeline.pipelineLabel")} {fmtAED(totalValue)}
            {isSales && <span className="ml-2 text-[10px] text-copper-400">{t("kpi.onlyYourLeads")}</span>}
            {isUpdating && <span className="ml-2 text-[10px] text-amber-400">{t("common.saving")}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onToggleEmptyStages}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border/40 hover:border-border"
          >
            {showEmptyStages ? t("pipeline.hideEmpty") : t("pipeline.showEmpty")}
          </button>
          <button onClick={() => router.push("/leads/new")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/85 transition-colors">
            <Plus className="w-3.5 h-3.5" />{t("common.create")}
          </button>
        </div>
      </div>

      {/* ─── Stage totals bar (T2-2 unified KanbanStats unit) ─── */}
      <KanbanStats
        leads={leads}
        onStageClick={(k) => {
          const el = document.getElementById(`stage-${k}`);
          if (el) el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
        }}
      />

      {/* ─── Kanban Board ─── */}
      {/* T2-1: flex-1 + min-h-0 lets the kanban fill the remaining
          DashboardScrollContainer space without calc(100vh - 280px). */}
      <div className="relative flex-1 min-h-0">
        {/* Left arrow */}
        <button
          onClick={() => scrollContainerRef.current?.scrollBy({ left: -310, behavior: "smooth" })}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 bg-background/80 rounded-full p-1.5 shadow hover:bg-background"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {/* Right arrow */}
        <button
          onClick={() => scrollContainerRef.current?.scrollBy({ left: 310, behavior: "smooth" })}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 bg-background/80 rounded-full p-1.5 shadow hover:bg-background"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {/* T2-1: scroll container is now h-full — no more calc(100vh - 280px). */}
        <div
          ref={scrollContainerRef}
          className="h-full overflow-x-auto overflow-y-auto snap-x snap-mandatory scrollbar-visible"
          style={{ scrollBehavior: "smooth" }}
        >
          {/* T2-1: h-full lets columns fill the kanban row. */}
          <div className="flex gap-3 min-w-max px-10 pb-4 h-full">
            {STAGES.filter((s) => {
              // Always show won/lost; otherwise respect showEmptyStages toggle.
              if (s.key === "won" || s.key === "lost") return true;
              if (showEmptyStages) return true;
              return (columns[s.key]?.length || 0) > 0;
            }).map((stage) => {
              const items = columns[stage.key] || [];
              const isOver = draggingOverStage === stage.key;
              const isWon = stage.key === "won";
              const isLost = stage.key === "lost";

              return (
                <div
                  key={stage.key}
                  id={`stage-${stage.key}`}
                  onDragEnter={() => onDragEnter(stage.key)}
                  onDragOver={(e) => onDragOver(e, stage.key)}
                  onDragLeave={() => onDragLeave(stage.key)}
                  onDrop={(e) => onDrop(e, stage.key)}
                  className={cn(
                    // T2-1: h-full lets the column fill the kanban row,
                    // which in turn fills the DashboardScrollContainer.
                    "h-full flex flex-col w-[300px] shrink-0 rounded-xl border transition-all duration-150 snap-start",
                    stage.bg, stage.border,
                    isOver && "ring-2 ring-copper-500/50 border-copper-500/30 scale-[1.01]",
                    isWon && "bg-emerald-950/10",
                    isLost && "bg-muted/20",
                  )}
                >
                  {/* Column header */}
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-inherit/30 sticky top-0 z-10">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: stage.color }} />
                      <span className="text-sm font-semibold text-foreground">{t(stage.labelKey as any)}</span>
                      <span className="text-xs text-muted-foreground bg-background/30 px-1.5 py-0.5 rounded-full">
                        {items.length}
                      </span>
                    </div>
                    {!isWon && !isLost && (
                      <button
                        onClick={() => router.push(`/leads?stage=${stage.key}`)}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                        title={t("pipeline.viewAllInStage")}
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {/* T2-1: Cards container — flex-1 + min-h-0 fills the column. */}
                  <div className={cn(
                    "flex-1 min-h-0 p-2 space-y-2 overflow-y-auto transition-colors rounded-b-xl",
                    isOver && "bg-copper-500/5",
                  )}>
                    {/* Empty state */}
                    {items.length === 0 && (
                      <div className="flex items-center justify-center h-24">
                        <span className="text-xs text-muted-foreground/30">{t("pipeline.dropLeadsHere")}</span>
                      </div>
                    )}

                    {/* Cards */}
                    {items.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        onDragStart={onDragStart}
                        onLeadClick={(id) => router.push(`/leads/${id}`)}
                        salesUsers={salesUsers}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}