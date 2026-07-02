"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter, useSearchParams } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import QuickCreateLeadDialog from "@/components/QuickCreateLeadDialog";
import ExcelImportDialog from "@/components/leads/ExcelImportDialog";
import { usePipelineDragDrop } from "@/shared/hooks/usePipelineDragDrop";
import { useStageGuard } from "@/shared/hooks/useStageGuard";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { useLeadsData } from "./_hooks/useLeadsData";
import { useLeadMutations } from "./_hooks/useLeadMutations";
import { useLeadsFiltering } from "./_hooks/useLeadsFiltering";
import { LeadsHeader } from "./_components/LeadsHeader";
import { LeadsFilters } from "./_components/LeadsFilters";
import { LeadsBulkTransferBar } from "./_components/LeadsBulkTransferBar";
import { LeadsPipelineSummary } from "./_components/LeadsPipelineSummary";
import { LeadsKanbanBoard } from "./_components/LeadsKanbanBoard";
import {
  PIPELINE_STAGES,
} from "./_utils/constants";

function LeadsContent() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, lang } = useLanguage();

  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState(searchParams.get("stage") || "all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [alertFilter, setAlertFilter] = useState(searchParams.get("alert") || "all");
  const [recoveryFilter, setRecoveryFilter] = useState(!!searchParams.get("recovery"));
  const [transferFilter, setTransferFilter] = useState(!!searchParams.get("transfer"));
  const [reviewFilter, setReviewFilter] = useState(!!searchParams.get("review"));
  const [probabilityFilter, setProbabilityFilter] = useState<number | null>(null);
  const [followupFilter, setFollowupFilter] = useState(false);
  const [assignedToFilter, setAssignedToFilter] = useState(searchParams.get("assigned_to") || "all");
  const [showPipelineSummary, setShowPipelineSummary] = useState(true);
  const [qualityFilter, setQualityFilter] = useState("all");

  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // ── T3-3 step 7: 7 editor flags + noteLeadId + 3 editor texts sunk
  // into LeadCard. Page keeps reassignLeadId/reassigning because the
  // bulk-transfer bar also reads them.
  // Sales reassignment
  const [reassignLeadId, setReassignLeadId] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState(false);

  // Bulk reassignment
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const [showBulkTransfer, setShowBulkTransfer] = useState(false);
  const [bulkTransferTargetId, setBulkTransferTargetId] = useState<string>("");

  // ─── Data layer (T3-3 step 5: extracted into _hooks/useLeadsData) ───
  // Owns leads list, loading/error, current user role+id, sales users list,
  // and the derived userNameMap. All 4 queries route through useSupabaseQuery.
  const {
    leads: hookLeads,
    setLeads: hookSetLeads,
    loading: hookLoading,
    error: hookError,
    setError: hookSetError,
    userId: currentUserId,
    role: salesRole,
    salesUsers,
    userNameMap,
    fetchLeads,
  } = useLeadsData();

  // Local aliases for the rest of the file (preserve original names + keep
  // page-level mutation entry points working).
  const leads = hookLeads;
  const setLeads = hookSetLeads;
  const loading = hookLoading;
  const error = hookError;
  const setError = hookSetError;

  // ─── Mutation handlers (T3-3 step 6: extracted into _hooks/useLeadMutations) ───
  // Owns all lead-level writes: reassignSales, changeStage (94-line optimistic
  // lock + 4-table cascade), changeProbability, changeStatus, changeLostReason,
  // addQuickNote, updateNextAction, updateNextFollowup, handleDelete, writeEvent.
  // Mutations stay as direct supabase.from() calls (T1-1 freeze rule applies
  // to queries only).
  const {
    reassignSales,
    writeEvent,
    handleDelete,
    changeStage,
    changeProbability,
    changeStatus,
    changeLostReason,
    addQuickNote,
    updateNextAction,
    updateNextFollowup,
  } = useLeadMutations({
    leads,
    setLeads,
    userId: currentUserId,
    role: salesRole,
    salesUsers,
    userNameMap,
    fetchLeads,
    setError,
    t,
    lang,
    setReassignLeadId,
    setReassigning,
    // No `ui` bundle anymore (T3-3 step 7): LeadCard owns its own editor
    // state and resets its own pickers on click before invoking the
    // mutation handler. The hook no longer needs editor-clear setters —
    // those were only there because the page owned the state.
  });

  // ─── Infrastructure hooks ───
  const showEmptyStages = true;
  const { isValidTransition, getValidTransitions } = useStageGuard();
  const { onDragStart, onDragOver, onDragLeave, onDragEnter, onDrop, draggingLeadId, draggingOverStage } = usePipelineDragDrop(leads, setLeads, currentUserId);

  const toggleSelect = (id: string) => {
    setSelectedLeadIds(prev => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
    });
  };
  const selectAllVisible = (visibleIds: string[]) => setSelectedLeadIds(new Set(visibleIds));
  const clearSelection = () => setSelectedLeadIds(new Set());

  const bulkTransfer = async () => {
    if (!bulkTransferTargetId || selectedLeadIds.size === 0) return;
    setReassigning(true);
    const ids = Array.from(selectedLeadIds);
    const toUser = salesUsers.find((u: any) => u.id === bulkTransferTargetId);
    const toName = toUser?.full_name || toUser?.email || bulkTransferTargetId;
    for (const leadId of ids) {
      const oldLead = leads.find(l => l.id === leadId);
      const oldName = salesUsers.find((u: any) => u.id === oldLead?.assigned_to)?.full_name || "unassigned";
      await supabase.from("leads").update({ assigned_to: bulkTransferTargetId }).eq("id", leadId);
      await supabase.from("transfer_history").insert({ lead_id: leadId, from_user_id: oldLead?.assigned_to, to_user_id: bulkTransferTargetId, reason: "batch_reassign", transferred_by: (await supabase.auth.getUser()).data.user?.id });
      await supabase.from("activities").insert({ lead_id: leadId, type: "transfer", content: `Batch reassigned from ${oldName} to ${toName}`, user_id: (await supabase.auth.getUser()).data.user?.id });
      await supabase.from("business_events").insert({ lead_id: leadId, event_type: "transfer", description: `Batch reassigned from ${oldName} to ${toName}`, user_id: (await supabase.auth.getUser()).data.user?.id });
    }
    setReassigning(false);
    setShowBulkTransfer(false);
    clearSelection();
    fetchLeads();
  };

  // fetchLeads — provided by useLeadsData (T3-3 step 5). The hook owns the
  // initial fetch via useSupabaseQuery and exposes a refetch wrapper that
  // mutation handlers (changeStage / reassignSales / handleDelete / etc.)
  // call after a successful write.

  // ─── Mutation handlers ───
  // reassignSales / writeEvent / handleDelete / changeStage / changeProbability /
  // changeStatus / changeLostReason / addQuickNote / updateNextAction /
  // updateNextFollowup (and the STAGE_AUTO / STAGE_INDEX / TERMINAL_STAGES
  // constants consumed by changeStage) live in _hooks/useLeadMutations (T3-3
  // step 6). They are bound to page-level UI state via the `ui` parameter
  // object passed into the hook above.

  // ─── Filtering ───
  // T3-3 step 15: filter pipeline (filtered / columns / stageTotals /
  // sources) extracted to useLeadsFiltering. 11 filter clauses + sort
  // by updated_at desc + 9-stage bucket map + per-stage count/value
  // reductions + distinct source list — all moved there 1:1.
  //
  // The hook only reads state — it does not own any. All setters
  // (setSearch, setStageFilter, ...) still live on the page and feed
  // straight into LeadsFilters. Hook return values feed LeadsHeader /
  // LeadsPipelineSummary / LeadsFilters / LeadsKanbanBoard. Behaviour
  // is byte-identical to the inline useMemo triplet that used to live
  // here.
  const { filtered, columns, stageTotals, sources } = useLeadsFiltering({
    leads,
    search,
    stageFilter,
    sourceFilter,
    statusFilter,
    qualityFilter,
    probabilityFilter,
    alertFilter,
    recoveryFilter,
    transferFilter,
    reviewFilter,
    followupFilter,
    assignedToFilter,
  });

  const activeCount = filtered.filter(l => !l.final_status).length;
  const totalPipeline = filtered.filter(l => !l.final_status).reduce((sum, l) => sum + (l.quotation_value || 0), 0);

  return (
    <div className="space-y-0">
      {/* T3-3 step 8: SubNavTabs + page-title sticky div extracted to LeadsHeader.
          Returns Fragment so DOM is byte-identical: SubNavTabs stays outside
          DashboardScrollContainer, page-title div stays inside. */}
      <LeadsHeader
        activeCount={activeCount}
        totalPipeline={totalPipeline}
        showPipelineSummary={showPipelineSummary}
        setShowPipelineSummary={setShowPipelineSummary}
        setShowQuickCreate={setShowQuickCreate}
        setShowImport={setShowImport}
      />
      {/* T2-4: 锚定功能卡片 — 整页滚动时关键控件可见
          DashboardScrollContainer 建立 inner scroll 上下文，sticky 元素
          (page-title z-20 / filter-bar z-10) 才能正确锚定。 */}
      <DashboardScrollContainer className="p-4">
      {/* filter-bar sticky: pipeline summary (column header) + 筛选行
          锚定在 page-title 下方 — 滚下去也能改筛选条件 */}
      <div
        data-sticky-region="filter-bar"
        className="sticky z-10 bg-background/95 backdrop-blur-sm border-b -mx-4 px-4 py-2 space-y-3"
        style={{ top: 52 }}
      >
      {/* Pipeline summary bar — T3-3 step 13: 9-stage clickable summary
          grid extracted to LeadsPipelineSummary. Same DOM (the grid +
          per-stage button with chip + AED label + percentage bar), now
          driven entirely by props. Page still gates the whole region on
          `showPipelineSummary` and the surrounding sticky filter-bar. */}
      {showPipelineSummary && (
        <LeadsPipelineSummary
          stages={PIPELINE_STAGES}
          stageTotals={stageTotals}
          stageFilter={stageFilter}
          onStageFilterChange={setStageFilter}
          t={t}
        />
      )}

      {/* Filters — T3-3 step 9: filter row extracted to LeadsFilters
          (was L286-366). All 8 filter states + sources + salesUsers +
          filtered.length pass through; the wrapping <div className="flex
          gap-2 flex-wrap items-center"> moved inside the component, so
          DOM stays byte-identical. Stage→alert reset is now wired via
          onStageChange wrapper below (parent owns the dual-setter). */}
      <LeadsFilters
        search={search}
        setSearch={setSearch}
        stageFilter={stageFilter}
        onStageChange={(v) => { setStageFilter(v); setAlertFilter("all"); }}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        qualityFilter={qualityFilter}
        setQualityFilter={setQualityFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        probabilityFilter={probabilityFilter}
        setProbabilityFilter={setProbabilityFilter}
        followupFilter={followupFilter}
        setFollowupFilter={setFollowupFilter}
        alertFilter={alertFilter}
        setAlertFilter={setAlertFilter}
        recoveryFilter={recoveryFilter}
        setRecoveryFilter={setRecoveryFilter}
        transferFilter={transferFilter}
        setTransferFilter={setTransferFilter}
        reviewFilter={reviewFilter}
        setReviewFilter={setReviewFilter}
        assignedToFilter={assignedToFilter}
        setAssignedToFilter={setAssignedToFilter}
        sources={sources}
        salesUsers={salesUsers}
        filteredCount={filtered.length}
      />

      {/* Board — T3-3 step 14: the success-branch kanban grid extracted
          to LeadsKanbanBoard. The page still owns the error/loading
          branches (ErrorState / loading placeholder) because those are
          ambient fall-throughs that don't belong in any one stage.
          All LeadCard props + drag-drop wiring now route through the
          new component. Behaviour identical: same column header, same
          drop-zone ring, same empty-column em-dash, same dragstart. */}
      {error ? (
        <ErrorState message={error} onRetry={fetchLeads} />
      ) : loading ? (
        <div className="text-center text-muted-foreground py-16 text-sm">{t("common.loading")}</div>
      ) : (
        <LeadsKanbanBoard
          stages={PIPELINE_STAGES}
          columns={columns}
          draggingLeadId={draggingLeadId}
          draggingOverStage={draggingOverStage}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
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
          selectedLeadIds={selectedLeadIds}
          onToggleSelect={toggleSelect}
          onOpen={(id) => router.push(`/leads/${id}`)}
          onDragStart={onDragStart}
          t={t}
        />
      )}
      </div>
      {/* T3-3 step 10: bulk-transfer-bar sticky extracted to LeadsBulkTransferBar.
          Visibility gate (selectedCount > 0 AND role admin/boss) is now inside
          the component, matching the original conditional. All handlers
          (bulkTransfer / onSelectAll / onClear) stay on the page since they
          touch the page-level selection set and the bulkTransfer 4-table write. */}
      <LeadsBulkTransferBar
        selectedCount={selectedLeadIds.size}
        totalFiltered={filtered.length}
        salesRole={salesRole}
        showBulkTransfer={showBulkTransfer}
        setShowBulkTransfer={setShowBulkTransfer}
        bulkTransferTargetId={bulkTransferTargetId}
        setBulkTransferTargetId={setBulkTransferTargetId}
        salesUsers={salesUsers}
        reassigning={reassigning}
        bulkTransfer={bulkTransfer}
        onSelectAll={() => selectAllVisible(filtered.map(l => l.id))}
        onClear={clearSelection}
      />
      <QuickCreateLeadDialog open={showQuickCreate} onOpenChange={setShowQuickCreate} onCreated={fetchLeads} />
      <ExcelImportDialog open={showImport} onOpenChange={setShowImport} onImported={fetchLeads} />
    </DashboardScrollContainer>
    </div>
  );
}

export default function LeadsPage() {
  const { t } = useLanguage();
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64 text-muted-foreground text-sm">{t("common.loading")}</div>}>
      <LeadsContent />
    </Suspense>
  );
}
