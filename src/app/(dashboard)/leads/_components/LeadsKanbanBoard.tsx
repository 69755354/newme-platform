"use client";

/**
 * LeadsKanbanBoard — T3-3 step 14 extracted from leads/page.tsx (was L307-372)
 *
 * The 9-column pipeline board. Pure presentational container that:
 *   - Maps over the 9 PIPELINE_STAGES and renders one kanban column each
 *   - Each column shows a header (color dot + translated label + count chip +
 *     AED total when > 0) and a vertical stack of LeadCard items
 *   - Wires the 4 HTML5 drag events (enter / over / leave / drop) on the
 *     column wrapper so the kanban supports drag-and-drop stage transitions
 *   - Adds the active drop zone visual (ring-2 + copper border) when the
 *     page-supplied `draggingOverStage` matches this column
 *   - Left/right arrow buttons + snap-x scrolling (ported from pipeline KanbanBoard)
 *   - Keyboard ←→ navigation is handled in the parent page via the forwarded ref
 *
 * Empty columns render a centred em-dash placeholder (was the inline ternary
 * inside the items.map). Selected leads get a check affordance inherited from
 * LeadCard's `selected` prop, driven by the parent page's selection set.
 *
 * The page still owns:
 *   - ErrorState / loading branch (this component is the success branch only)
 *   - selection set + toggle/selectAll/clear callbacks
 *   - navigation (router.push for /leads/:id)
 *   - mutation handlers that LeadCard invokes
 *   - keyboard navigation (ArrowLeft/Right → scrollBy on the forwarded ref)
 *
 * Props are deliberately verbose (every LeadCard binding is passed through)
 * to avoid forwarding {...rest} semantics that would hide prop surface.
 *
 * Behavioural contract: 100% byte-identical DOM, drop targets, drag handlers,
 * and LeadCard prop wiring compared to the inline version.
 */

import { useState, useCallback, forwardRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtAED } from "../_utils/format";
import { LeadCard } from "./LeadCard";
import type { Lead } from "../_hooks/useLeadsData";
import type { UseLeadMutationsReturn, SalesUser } from "../_hooks/useLeadMutations";

type PipelineStage = {
  key: string;
  label: string;
  color: string;
  bg: string;
  border: string;
};

export type KanbanColumn = Record<string, Lead[]>;

type Props = {
  stages: readonly PipelineStage[];
  columns: KanbanColumn;
  draggingLeadId: string | null;
  draggingOverStage: string | null;
  onDragEnter: (stageKey: string) => void;
  onDragOver: (e: React.DragEvent, stageKey: string) => void;
  onDragLeave: (stageKey: string) => void;
  onDrop: (e: React.DragEvent, stageKey: string) => void;
  // LeadCard bindings — forwarded verbatim. Mutation handler signatures
  // are inferred from useLeadMutations's exported return type so they
  // stay in sync with the hook (no hand-maintained duplication).
  salesRole: string | null;
  currentUserId: string | null;
  userNameMap: Record<string, string>;
  salesUsers: SalesUser[];
  changeStage: UseLeadMutationsReturn["changeStage"];
  changeProbability: UseLeadMutationsReturn["changeProbability"];
  changeStatus: UseLeadMutationsReturn["changeStatus"];
  changeLostReason: UseLeadMutationsReturn["changeLostReason"];
  addQuickNote: UseLeadMutationsReturn["addQuickNote"];
  updateNextAction: UseLeadMutationsReturn["updateNextAction"];
  updateNextFollowup: UseLeadMutationsReturn["updateNextFollowup"];
  reassignSales: UseLeadMutationsReturn["reassignSales"];
  handleDelete: UseLeadMutationsReturn["handleDelete"];
  reassignLeadId: string | null;
  reassigning: boolean;
  setReassignLeadId: (id: string | null) => void;
  setReassigning: (v: boolean) => void;
  selectedLeadIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onDragStart: (e: React.DragEvent, leadId: string) => void;
  t: (key: string) => string;
};

export const LeadsKanbanBoard = forwardRef<HTMLDivElement, Props>(function LeadsKanbanBoard(
  {
    stages,
    columns,
    draggingLeadId,
    draggingOverStage,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    salesRole,
    currentUserId,
    userNameMap,
    salesUsers,
    changeStage,
    changeProbability,
    changeStatus,
    changeLostReason,
    addQuickNote,
    updateNextAction,
    updateNextFollowup,
    reassignSales,
    handleDelete,
    reassignLeadId,
    reassigning,
    setReassignLeadId,
    setReassigning,
    selectedLeadIds,
    onToggleSelect,
    onOpen,
    onDragStart,
    t,
  },
  ref
) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  return (
    <div className="relative -mx-4 px-4">
      {/* Left arrow */}
      {canScrollLeft && (
        <button
          onClick={() =>
            (ref as React.RefObject<HTMLDivElement>)?.current?.scrollBy({
              left: -310,
              behavior: "smooth",
            })
          }
          className="absolute left-6 top-1/2 -translate-y-1/2 z-20 bg-background/80 rounded-full p-1.5 shadow hover:bg-background"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}

      {/* Right arrow */}
      {canScrollRight && (
        <button
          onClick={() =>
            (ref as React.RefObject<HTMLDivElement>)?.current?.scrollBy({
              left: 310,
              behavior: "smooth",
            })
          }
          className="absolute right-6 top-1/2 -translate-y-1/2 z-20 bg-background/80 rounded-full p-1.5 shadow hover:bg-background"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}

      {/* Scroll container */}
      <div
        ref={ref}
        onScroll={handleScroll}
        className="overflow-x-auto pb-6 snap-x snap-mandatory scrollbar-visible"
        style={{ scrollBehavior: "smooth" }}
      >
        <div className="flex gap-4 min-w-max px-10 pb-4">
          {stages.map((stage) => {
            const items = columns[stage.key] || [];
            const totalVal = items.reduce(
              (sum, l) => sum + (l.quotation_value || 0),
              0
            );
            const isLost = stage.key === "lost";
            return (
              <div
                key={stage.key}
                onDragEnter={() => onDragEnter(stage.key)}
                onDragOver={(e) => onDragOver(e, stage.key)}
                onDragLeave={() => onDragLeave(stage.key)}
                onDrop={(e) => onDrop(e, stage.key)}
                className={cn(
                  "flex flex-col min-w-[300px] w-[300px] min-h-[400px] max-h-[70vh] rounded-xl border p-3 shrink-0 transition-all duration-150 snap-start",
                  stage.bg,
                  stage.border,
                  draggingOverStage === stage.key &&
                    "ring-2 ring-copper-500/50 border-copper-500/30"
                )}
              >
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: stage.color }}
                    />
                    <span className="text-sm font-semibold text-foreground">
                      {t(`stageLabels.${stage.key}`)}
                    </span>
                    <span className="text-xs text-muted-foreground bg-background/50 px-1.5 py-0.5 rounded-full">
                      {items.length}
                    </span>
                  </div>
                  {totalVal > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {fmtAED(totalVal)}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
                  {items.length === 0 && (
                    <div className="flex-1 flex items-center justify-center">
                      <span className="text-xs text-muted-foreground/30">—</span>
                    </div>
                  )}
                  {items.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      salesRole={salesRole}
                      currentUserId={currentUserId}
                      userNameMap={userNameMap}
                      salesUsers={salesUsers}
                      changeStage={changeStage}
                      changeProbability={changeProbability}
                      changeStatus={changeStatus}
                      changeLostReason={changeLostReason}
                      addQuickNote={addQuickNote}
                      updateNextAction={updateNextAction}
                      updateNextFollowup={updateNextFollowup}
                      reassignSales={reassignSales}
                      handleDelete={handleDelete}
                      reassignLeadId={reassignLeadId}
                      reassigning={reassigning}
                      setReassignLeadId={setReassignLeadId}
                      setReassigning={setReassigning}
                      selected={selectedLeadIds.has(lead.id)}
                      onToggleSelect={() => onToggleSelect(lead.id)}
                      onOpen={(id) => onOpen(id)}
                      draggingLeadId={draggingLeadId}
                      onDragStart={onDragStart}
                      isLostColumn={isLost}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
