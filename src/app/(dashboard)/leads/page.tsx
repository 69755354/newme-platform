"use client";

import { useEffect, useState, useMemo, useCallback, Suspense } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter, useSearchParams } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, fmtDubai } from "@/lib/utils";
import { toast } from "sonner";
import QuickCreateLeadDialog from "@/components/QuickCreateLeadDialog";
import ExcelImportDialog from "@/components/leads/ExcelImportDialog";
import SubNavTabs from "@/components/SubNavTabs";
import { usePipelineDragDrop } from "@/shared/hooks/usePipelineDragDrop";
import { useStageGuard } from "@/shared/hooks/useStageGuard";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { useLeadsData, Lead } from "./_hooks/useLeadsData";
import { useLeadMutations } from "./_hooks/useLeadMutations";
import {
  Search, X, Plus, Phone, Calendar, MapPin, ChevronRight,
  MoreHorizontal, Edit3, Send, TrendingUp, Building2,
  User, Users, Clock, AlertTriangle, RotateCcw, GripHorizontal, ShieldAlert,
  BarChart3, Megaphone, Upload, Trash2,
} from "lucide-react";
import {
  PIPELINE_STAGES, STATUS_EMOJIS, STAGE_COLORS, isPlaceholder,
  SOURCE_ICONS, STATUS_LABELS, PROBABILITIES, LOST_REASONS,
} from "./_utils/constants";
import { daysSince, fmtAED } from "./_utils/format";

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
  const [editingStage, setEditingStage] = useState<string | null>(null);
  const [editingProbability, setEditingProbability] = useState<string | null>(null);
  const [editingStatus, setEditingStatus] = useState<string | null>(null);
  const [editingLostReason, setEditingLostReason] = useState<string | null>(null);
  const [editingNextAction, setEditingNextAction] = useState<string | null>(null);
  const [editingNextFollowup, setEditingNextFollowup] = useState<string | null>(null);
  const [noteLeadId, setNoteLeadId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [nextActionText, setNextActionText] = useState("");
  const [nextFollowupText, setNextFollowupText] = useState("");

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
    ui: {
      noteText,
      setNoteText,
      setNoteLeadId,
      nextActionText,
      setNextActionText,
      nextFollowupText,
      setNextFollowupText,
      setEditingStage,
      setEditingProbability,
      setEditingStatus,
      setEditingLostReason,
      setEditingNextAction,
      setEditingNextFollowup,
      setReassignLeadId,
      setReassigning,
    },
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
  const filtered = useMemo(() => {
    let result = [...leads];
    if (stageFilter !== "all") result = result.filter(l => (l.final_status || l.stage) === stageFilter);
    if (sourceFilter !== "all") result = result.filter(l => l.source === sourceFilter);
    if (statusFilter !== "all") result = result.filter(l => l.lead_status === statusFilter);
    if (qualityFilter !== "all") result = result.filter(l => l.quality === qualityFilter);
    if (probabilityFilter !== null) result = result.filter(l => l.win_probability === probabilityFilter);
    if (alertFilter === "yellow") {
      result = result.filter(l => {
        const d = daysSince(l.last_contact_date || l.updated_at);
        return d !== null && d >= 7 && d < 14 && !l.final_status;
      });
    }
    if (alertFilter === "red") {
      result = result.filter(l => {
        const d = daysSince(l.last_contact_date || l.updated_at);
        return d !== null && d >= 14 && !l.final_status;
      });
    }
    if (recoveryFilter) result = result.filter(l => l.recovery_candidate);
    if (transferFilter) result = result.filter(l => l.transfer_candidate);
    if (reviewFilter) result = result.filter(l => l.sales_manager_review);
    if (assignedToFilter !== "all") result = result.filter(l => l.assigned_to === assignedToFilter);
    if (followupFilter) {
      const todayStr = new Date().toISOString().split("T")[0];
      result = result.filter(l => {
        if (!l.next_followup_date) return false;
        if (l.final_status) return false;
        return l.next_followup_date <= todayStr;
      });
    }
    if (search.trim()) {
      const s = search.toLowerCase().trim();
      result = result.filter(l =>
        (l.customer_name || "").toLowerCase().includes(s) ||
        (l.phone || "").includes(s) ||
        (l.location || "").toLowerCase().includes(s) ||
        (l.assigned_to || "").toLowerCase().includes(s)
      );
    }
    result.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return result;
  }, [leads, search, stageFilter, sourceFilter, statusFilter, alertFilter, recoveryFilter, transferFilter, reviewFilter, probabilityFilter, followupFilter, assignedToFilter, qualityFilter]);

  const columns = useMemo(() => {
    const g: Record<string, Lead[]> = {};
    for (const s of PIPELINE_STAGES) g[s.key] = [];
    // won/lost now live in final_status; fall back to stage for the dual-source transition
    for (const l of filtered) { const key = l.final_status || l.stage; if (g[key]) g[key].push(l); }
    return g;
  }, [filtered]);

  const stageTotals = useMemo(() => {
    const t: Record<string, { count: number; value: number }> = {};
    for (const s of PIPELINE_STAGES) {
      t[s.key] = { count: columns[s.key]?.length || 0, value: columns[s.key]?.reduce((sum, l) => sum + (l.quotation_value || 0), 0) || 0 };
    }
    return t;
  }, [columns]);

  const activeCount = filtered.filter(l => !l.final_status).length;
  const totalPipeline = filtered.filter(l => !l.final_status).reduce((sum, l) => sum + (l.quotation_value || 0), 0);
  const sources = useMemo(() => [...new Set(leads.map(l => l.source))].filter(Boolean).sort(), [leads]);

  return (
    <div className="space-y-0">
      <SubNavTabs
        items={[
          { href: "/leads", labelKey: "leads.subnavAllLeads", iconName: "users" },
          { href: "/ads", labelKey: "leads.subnavAdAnalytics", iconName: "megaphone" },
        ]}
      />
      {/* T2-4: 锚定功能卡片 — 整页滚动时关键控件可见
          DashboardScrollContainer 建立 inner scroll 上下文，sticky 元素
          (page-title z-20 / filter-bar z-10) 才能正确锚定。 */}
      <DashboardScrollContainer className="p-4">
      {/* page-title sticky: h1 + 顶部操作按钮 (Pipeline overview / Create / Import)
          永远可见 — 用户滚到底部也知道自己在 leads 列表 */}
      <div
        data-sticky-region="page-title"
        className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b -mx-4 px-4 py-2"
      >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{t("leads.title")}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{t("leads.activePipeline").replace("{count}", String(activeCount)).replace("{value}", fmtAED(totalPipeline) || "—")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPipelineSummary(!showPipelineSummary)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
            <TrendingUp className="w-3.5 h-3.5" />{t("leads.pipelineOverview")}
          </button>
          <button onClick={() => setShowQuickCreate(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/85 transition-colors">
            <Plus className="w-3.5 h-3.5" />{t("common.create")}
          </button>
          <button onClick={() => setShowImport(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
            <Upload className="w-3.5 h-3.5" />{t("leads.importBtn")}
          </button>
        </div>
      </div>
      </div>

      {/* filter-bar sticky: pipeline summary (column header) + 筛选行
          锚定在 page-title 下方 — 滚下去也能改筛选条件 */}
      <div
        data-sticky-region="filter-bar"
        className="sticky z-10 bg-background/95 backdrop-blur-sm border-b -mx-4 px-4 py-2 space-y-3"
        style={{ top: 52 }}
      >
      {/* Pipeline summary bar */}
      {showPipelineSummary && (
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-1.5">
          {PIPELINE_STAGES.map((s) => {
            const totals = stageTotals[s.key];
            return (
              <button key={s.key} onClick={() => setStageFilter(stageFilter === s.key ? "all" : s.key)}
                className={cn("text-left p-2 rounded-lg border transition-all", stageFilter === s.key ? "ring-2 ring-offset-1 ring-offset-background" : "", s.bg, s.border)}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[10px] font-medium text-muted-foreground truncate">{t(`stageLabels.${s.key}`)}</span>
                  <span className="text-xs font-bold text-foreground ml-1">{totals.count}</span>
                </div>
                <div className="text-right mb-1">
                  <span className="text-[9px] text-muted-foreground">{totals.value > 0 ? fmtAED(totals.value) : "—"}</span>
                </div>
                <div className="h-1 bg-muted rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min((totals.count / Math.max(1, ...Object.values(stageTotals).map(x => x.count))) * 100, 100)}%`, backgroundColor: s.color }} />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder={t("leads.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9 text-sm" />
          {search && <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>}
        </div>
        <select value={stageFilter} onChange={(e) => { setStageFilter(e.target.value); setAlertFilter("all"); }}
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
        <span className="text-xs text-muted-foreground ml-auto">{t("leads.nResults").replace("{n}", String(filtered.length))}</span>
      </div>

      {/* Board */}
      {error ? (
        <ErrorState message={error} onRetry={fetchLeads} />
      ) : loading ? (
        <div className="text-center text-muted-foreground py-16 text-sm">{t("common.loading")}</div>
      ) : (
        <div className="overflow-x-auto pb-6 -mx-4 px-4">
          <div className="flex gap-4 min-w-max md:min-w-0">
            {PIPELINE_STAGES.map((stage) => {
              const items = columns[stage.key] || [];
              const totalVal = items.reduce((sum, l) => sum + (l.quotation_value || 0), 0);
              const isLost = stage.key === "lost";
              return (
                <div key={stage.key}
                  onDragEnter={() => onDragEnter(stage.key)}
                  onDragOver={(e) => onDragOver(e, stage.key)}
                  onDragLeave={() => onDragLeave(stage.key)}
                  onDrop={(e) => onDrop(e, stage.key)}
                  className={cn("flex flex-col w-[340px] min-h-[400px] rounded-xl border p-3 shrink-0 md:w-1/5 md:min-w-0 transition-all duration-150", stage.bg, stage.border, draggingOverStage === stage.key && "ring-2 ring-copper-500/50 border-copper-500/30")}>
                  <div className="flex items-center justify-between mb-3 px-1">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stage.color }} />
                      <span className="text-sm font-semibold text-foreground">{t(`stageLabels.${stage.key}`)}</span>
                      <span className="text-xs text-muted-foreground bg-background/50 px-1.5 py-0.5 rounded-full">{items.length}</span>
                    </div>
                    {totalVal > 0 && <span className="text-[10px] text-muted-foreground">{fmtAED(totalVal)}</span>}
                  </div>
                  <div className="flex flex-col gap-2 flex-1 overflow-y-auto">
                    {items.length === 0 && <div className="flex-1 flex items-center justify-center"><span className="text-xs text-muted-foreground/30">—</span></div>}
                    {items.map((lead) => {
                      const days = daysSince(lead.last_contact_date || lead.updated_at);
                      const isHot = lead.lead_status === "hot";
                      const isStale = days !== null && days > 7 && !lead.final_status;
                      const isCrit = days !== null && days >= 14 && !lead.final_status;
                      const isEditing = editingStage === lead.id;
                      const isEditingProb = editingProbability === lead.id;
                      const isEditingSt = editingStatus === lead.id;
                      const isEditingLost = editingLostReason === lead.id;
                      const isEditingAction = editingNextAction === lead.id;
                      const isEditingFollowup = editingNextFollowup === lead.id;
                      const isNoting = noteLeadId === lead.id;
                      const statusStyle = STATUS_LABELS[lead.lead_status || ""];
                      const stageIdx = PIPELINE_STAGES.findIndex(s => s.key === lead.stage);
                      const nextStages = PIPELINE_STAGES.filter((s, i) => i > stageIdx && !["won", "lost"].includes(s.key));

                      const isReassigning = reassignLeadId === lead.id;

                      return (
                        <Card key={lead.id}
                          draggable
                          onDragStart={(e) => onDragStart(e, lead.id)}
                          className={cn(
                          "cursor-pointer transition-all duration-150 group relative",
                          "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-foreground/5",
                          draggingLeadId === lead.id && "opacity-40",
                          isHot && "ring-1 ring-rose-500/30",
                          isCrit ? "ring-2 ring-red-500/40" : isStale ? "ring-1 ring-amber-500/30" : "",
                          lead.recovery_candidate && "ring-1 ring-orange-500/30",
                          lead.transfer_candidate && "ring-1 ring-red-500/20",
                          lead.sales_manager_review && "ring-1 ring-purple-500/30",
                          selectedLeadIds.has(lead.id) && "ring-2 ring-copper-500 bg-copper-500/5",
                        )}
                          onClick={() => { if (!isEditing && !isEditingProb && !isEditingSt && !isEditingLost && !isEditingAction && !isEditingFollowup && !isNoting && !isReassigning) router.push(`/leads/${lead.id}`); }}>
                          <CardContent className="p-3 space-y-2">
                            {/* Bulk select checkbox — top-right */}
                            {(salesRole === "admin" || salesRole === "boss") && (
                              <div className="absolute top-2 right-2 z-10" onClick={e => e.stopPropagation()}>
                                <input type="checkbox" checked={selectedLeadIds.has(lead.id)}
                                  onChange={() => toggleSelect(lead.id)}
                                  className="w-4 h-4 rounded border-border/50 bg-card accent-copper-500 cursor-pointer opacity-0 group-hover:opacity-100 checked:opacity-100 transition-opacity" />
                              </div>
                            )}
                            {/* Header row */}
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="text-sm font-medium text-foreground truncate max-w-[180px]">{!isPlaceholder(lead.customer_name) ? lead.customer_name : (lead.phone || t("common.unnamed"))}</p>
                                  {isHot && <span className="text-[10px]">🔥</span>}
                                  {statusStyle && <span className={cn("text-[9px] px-1 py-0.5 rounded font-medium", statusStyle.bg, statusStyle.color)}>{STATUS_EMOJIS[lead.lead_status || ""] || ""} {t(`statusLabels.${lead.lead_status || ""}`)}</span>}
                                  {lead.win_probability != null && (
                                    <span className={cn("text-[10px] font-semibold", lead.win_probability >= 70 ? "text-emerald-400" : lead.win_probability >= 30 ? "text-amber-400" : "text-muted-foreground")}>
                                      {lead.win_probability}%
                                    </span>
                                  )}
                                  {lead.recovery_candidate && <span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/10 text-orange-400">{t("leads.recovery")}</span>}
                                  {lead.quality === 'poor' && <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-red-500/10 text-red-400">⚠️ {t("leads.poorLead")}</span>}
                                  {lead.transfer_candidate && <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/10 text-red-400">{t("leads.transfer")}</span>}
                                  {lead.sales_manager_review && <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400">{t("leads.review")}</span>}
                                </div>
                                {(!isPlaceholder(lead.property_type) || !isPlaceholder(lead.location)) && (
                                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                                    <Building2 className="w-3 h-3 shrink-0" />{[lead.property_type, lead.location].filter(v => !isPlaceholder(v)).join(" · ")}
                                  </div>
                                )}
                              </div>
                              {lead.quotation_value != null && lead.quotation_value > 0 && (
                                <span className="text-xs font-semibold text-copper-400 shrink-0">{fmtAED(lead.quotation_value)}</span>
                              )}
                            </div>

                            {/* Next action / follow-up row */}
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
                              {lead.next_action && <span className="flex items-center gap-0.5"><span className="text-[10px]">📋</span>{t(`leads.nextActionLabels.${lead.next_action}`) || lead.next_action}</span>}
                              {lead.next_followup_date && (
                                <span className={cn("flex items-center gap-0.5",
                                  new Date(lead.next_followup_date) < new Date() ? "text-rose-400" : "text-muted-foreground"
                                )}>
                                  <Calendar className="w-3 h-3" />{fmtDubai(new Date(lead.next_followup_date), { locale: t("locale.dateLocale") })}
                                </span>
                              )}
                              {lead.followup_count != null && <span>{t("leads.nFollowups").replace("{n}", String(lead.followup_count))}</span>}
                            </div>

                            {/* Bottom info row */}
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                <span>{SOURCE_ICONS[lead.source] || "📋"} {t(`sourceLabels.${lead.source}`) || lead.source}</span>
                                {lead.assigned_to && (
                                  <span className="relative inline-flex items-center gap-1">
                                    <User className="w-3 h-3" />
                                    <span>{userNameMap[lead.assigned_to] || t("leads.unassigned")}</span>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setReassignLeadId(reassignLeadId === lead.id ? null : lead.id); }}
                                      className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors ml-0.5"
                                      title="Reassign"
                                    >
                                      ↔️
                                    </button>
                                    {reassignLeadId === lead.id && (
                                      <div className="absolute top-full left-0 mt-1 w-48 z-50 bg-muted border border-border rounded-lg shadow-xl py-1 max-h-40 overflow-y-auto"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        {reassigning && <div className="px-3 py-2 text-xs text-muted-foreground">Reassigning...</div>}
                                        {salesUsers.map((u) => (
                                          <button key={u.id}
                                            onClick={() => reassignSales(lead.id, u.id)}
                                            className={cn(
                                              "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-muted transition-colors",
                                              lead.assigned_to === u.id ? "text-copper-400" : "text-foreground"
                                            )}
                                          >
                                            <span className={cn("w-1.5 h-1.5 rounded-full", lead.assigned_to === u.id ? "bg-copper-400" : "bg-gray-600")} />
                                            <span className="truncate">{u.full_name || u.email}</span>
                                          </button>
                                        ))}
                                        {salesUsers.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No users</p>}
                                      </div>
                                    )}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                {days !== null && (
                                  <span className={cn("text-[10px] flex items-center gap-0.5",
                                    isCrit ? "text-rose-400 font-semibold" : isStale ? "text-amber-400" : "text-muted-foreground"
                                  )}>
                                    <Clock className="w-3 h-3" />{days === 0 ? t("common.today") : t("common.nDays").replace("{n}", String(days))}
                                  </span>
                                )}
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                  {!isLost && nextStages.slice(0, 2).map(ns => (
                                    <button key={ns.key} title={t("leads.moveTo").replace("{stage}", t(`stageLabels.${ns.key}`))}
                                      className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                                      onClick={(e) => { e.stopPropagation(); changeStage(lead.id, ns.key); }}>
                                      <ChevronRight className="w-3.5 h-3.5" />
                                    </button>
                                  ))}
                                  <button title={t("leads.quickNote")}
                                    className={cn("p-1 rounded hover:bg-accent transition-colors", isNoting ? "text-copper-400" : "text-muted-foreground hover:text-foreground")}
                                    onClick={(e) => { e.stopPropagation(); setNoteLeadId(isNoting ? null : lead.id); setNoteText(""); }}>
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>
                                  <button title={t("common.actions")}
                                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                                    onClick={(e) => { e.stopPropagation(); setEditingStage(isEditing ? null : lead.id); }}>
                                    <MoreHorizontal className="w-3.5 h-3.5" />
                                  </button>
                                  {(salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && lead.assigned_to === currentUserId)) && (
                                    <button title={t("common.delete") || "Delete"}
                                      className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                                      onClick={(e) => { e.stopPropagation(); handleDelete(lead.id, lead.assigned_to); }}>
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* ─── Expandable Inline Editors ─── */}
                            {/* Stage editor */}
                            {isEditing && (
                              <div className="pt-2 border-t border-border" onClick={(e) => e.stopPropagation()}>
                                <div className="flex flex-wrap gap-1 mb-1">
                                  {PIPELINE_STAGES.map(s => (
                                    <button key={s.key}
                                      className={cn("text-[10px] px-2 py-1 rounded-full border transition-colors", lead.stage === s.key ? "border-transparent text-foreground" : "border-border text-muted-foreground hover:border-foreground/30")}
                                      style={lead.stage === s.key ? { backgroundColor: s.color } : {}}
                                      onClick={() => changeStage(lead.id, s.key)}>{t(`stageLabels.${s.key}`)}</button>
                                  ))}
                                </div>
                                <div className="flex gap-1 mt-1 flex-wrap">
                                  {/* Probability */}
                                  <button onClick={() => { setEditingProbability(lead.id); setEditingStage(null); }}
                                    className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                                    {t("leads.probability")} {lead.win_probability || "—"}%
                                  </button>
                                  {/* Status */}
                                  <button onClick={() => { setEditingStatus(lead.id); setEditingStage(null); }}
                                    className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                                    {t("leads.status")} {lead.lead_status ? `${STATUS_EMOJIS[lead.lead_status] || ""} ${t(`statusLabels.${lead.lead_status}`)}` : "—"}
                                  </button>
                                  {/* Next action */}
                                  <button onClick={() => { setEditingNextAction(lead.id); setNextActionText(lead.next_action || ""); setEditingStage(null); }}
                                    className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                                    📋{t("leads.nextAction")}
                                  </button>
                                  {/* Next followup */}
                                  <button onClick={() => { setEditingNextFollowup(lead.id); setNextFollowupText(lead.next_followup_date || ""); setEditingStage(null); }}
                                    className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                                    📅{t("leads.followUp")}
                                  </button>
                                  {/* Lost reason (only show for lost stage) */}
                                  {isLost && (
                                    <button onClick={() => { setEditingLostReason(lead.id); setEditingStage(null); }}
                                      className="text-[10px] px-2 py-0.5 rounded border border-rose-500/30 text-rose-400 hover:bg-rose-500/10">
                                      {t("leadDetail.lostReason")} {lead.lost_reason || "—"}
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Probability selector */}
                            {isEditingProb && (
                              <div className="pt-2 border-t border-border" onClick={(e) => e.stopPropagation()}>
                                <div className="flex gap-1 flex-wrap">
                                  {PROBABILITIES.map(p => (
                                    <button key={p}
                                      className={cn("text-[10px] px-2 py-1 rounded-full border transition-colors",
                                        lead.win_probability === p ? "bg-copper-500 text-black border-copper-500" : "border-border text-muted-foreground hover:border-foreground/30")}
                                      onClick={() => changeProbability(lead.id, p)}>{p}%</button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Status selector */}
                            {isEditingSt && (
                              <div className="pt-2 border-t border-border" onClick={(e) => e.stopPropagation()}>
                                <div className="flex gap-1 flex-wrap">
                                  {Object.entries(STATUS_LABELS).map(([k, v]) => (
                                    <button key={k}
                                      className={cn("text-[10px] px-2 py-1 rounded-full border transition-colors",
                                        lead.lead_status === k ? "border-transparent text-foreground" : "border-border text-muted-foreground hover:border-foreground/30")}
                                      style={lead.lead_status === k ? { backgroundColor: k === "hot" ? "#f43f5e" : k === "warm" ? "#f59e0b" : k === "cold" ? "#0ea5e9" : "#6b7280" } : {}}
                                      onClick={() => changeStatus(lead.id, k)}>{STATUS_EMOJIS[k] || ""} {t(`statusLabels.${k}`)}</button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Lost reason selector */}
                            {isEditingLost && (
                              <div className="pt-2 border-t border-border" onClick={(e) => e.stopPropagation()}>
                                <div className="flex gap-1 flex-wrap">
                                  {LOST_REASONS.map(r => (
                                    <button key={r}
                                      className={cn("text-[10px] px-2 py-1 rounded-full border transition-colors",
                                        lead.lost_reason === r ? "bg-rose-500 text-foreground border-rose-500" : "border-border text-muted-foreground hover:border-foreground/30")}
                                      onClick={() => changeLostReason(lead.id, r)}>{r}</button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Next action editor */}
                            {isEditingAction && (
                              <div className="pt-2 border-t border-border flex gap-1" onClick={(e) => e.stopPropagation()}>
                                <input autoFocus placeholder={t("leads.nextActionRequired")} value={nextActionText}
                                  onChange={(e) => setNextActionText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") updateNextAction(lead.id); if (e.key === "Escape") setEditingNextAction(null); }}
                                  className="flex-1 h-7 text-xs bg-background border border-border rounded px-2 focus:outline-none focus:ring-1 focus:ring-primary text-foreground" />
                                <button onClick={() => updateNextAction(lead.id)} disabled={!nextActionText.trim()}
                                  className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-30"><Send className="w-3 h-3" /></button>
                              </div>
                            )}

                            {/* Next followup editor */}
                            {isEditingFollowup && (
                              <div className="pt-2 border-t border-border flex gap-1" onClick={(e) => e.stopPropagation()}>
                                <input autoFocus type="date" value={nextFollowupText}
                                  onChange={(e) => setNextFollowupText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Escape") setEditingNextFollowup(null); }}
                                  className="flex-1 h-7 text-xs bg-background border border-border rounded px-2 focus:outline-none focus:ring-1 focus:ring-primary text-foreground" />
                                <button onClick={() => updateNextFollowup(lead.id)} disabled={!nextFollowupText}
                                  className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-30"><Send className="w-3 h-3" /></button>
                              </div>
                            )}

                            {/* Note editor */}
                            {isNoting && (
                              <div className="pt-2 border-t border-border flex gap-1" onClick={(e) => e.stopPropagation()}>
                                <input autoFocus placeholder={t("leads.addNote")} value={noteText} onChange={(e) => setNoteText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") addQuickNote(lead.id); if (e.key === "Escape") setNoteLeadId(null); }}
                                  className="flex-1 h-7 text-xs bg-background border border-border rounded px-2 focus:outline-none focus:ring-1 focus:ring-primary text-foreground" />
                                <button onClick={() => addQuickNote(lead.id)} disabled={!noteText.trim()}
                                  className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-30"><Send className="w-3 h-3" /></button>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      </div>
      {/* bulk-transfer-bar sticky: 选中 lead 后出现在底部，方便用户随时操作
          选中的卡片滚到底，工具栏始终可见 */}
      {selectedLeadIds.size > 0 && (salesRole === "admin" || salesRole === "boss") && (
        <div
          data-sticky-region="bulk-transfer-bar"
          className="sticky bottom-0 z-10 bg-background/95 backdrop-blur-sm border-t -mx-4 px-4 py-2.5"
        >
          <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-copper-500/10 border border-copper-500/30">
            <span className="text-sm font-medium text-copper-300">{selectedLeadIds.size} leads selected</span>
            <div className="flex items-center gap-2">
              <button onClick={() => selectAllVisible(filtered.map(l => l.id))}
                className="text-xs text-copper-400 hover:text-copper-300">Select all {filtered.length}</button>
              <button onClick={clearSelection}
                className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
              {selectedLeadIds.size > 0 && !showBulkTransfer && (
                <button onClick={() => { setShowBulkTransfer(true); setBulkTransferTargetId(""); }}
                  className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-copper-500 text-foreground rounded-md hover:bg-copper-400 transition-colors">
                  Transfer →
                </button>
              )}
              {showBulkTransfer && (
                <>
                  <select value={bulkTransferTargetId} onChange={e => setBulkTransferTargetId(e.target.value)}
                    className="text-xs bg-card border border-border/50 rounded px-2 py-1 text-foreground">
                    <option value="">Select user...</option>
                    {salesUsers.filter((u: any) => u.role === "sales").map((u: any) => (
                      <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                    ))}
                  </select>
                  <button onClick={bulkTransfer} disabled={reassigning || !bulkTransferTargetId}
                    className="px-3 py-1 text-xs font-medium bg-emerald-600 text-foreground rounded-md hover:bg-emerald-500 disabled:opacity-40 transition-colors">
                    {reassigning ? "Transferring..." : `Transfer ${selectedLeadIds.size}`}
                  </button>
                  <button onClick={() => setShowBulkTransfer(false)}
                    className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
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
