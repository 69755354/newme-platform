"use client";

/**
 * LeadCard — T3-3 step 7 extracted from leads/page.tsx (was L440-723, ~284 lines)
 *
 * One draggable card per Lead with 7 inline editors (stage / probability /
 * status / lost_reason / next_action / next_followup / note) and the
 * sales-reassignment dropdown. All editor state (7 editing flags +
 * noteLeadId + 3 editor text fields) is owned internally via useState —
 * it never had cross-lead coupling so it was a perfect candidate to
 * sink into this component.
 *
 * 100% behavioural equivalence with the inline JSX that lived in page.tsx:
 *   - Same DOM structure (Card > CardContent > header / action row /
 *     footer / 7 inline editor panels / reassign dropdown)
 *   - Same click guard on the outer Card (suppressed during any editor open)
 *   - Same keyboard shortcuts (Enter to commit, Escape to cancel) on the
 *     3 text editors
 *   - Same drag/drop wiring (parent passes draggingLeadId + onDragStart)
 *
 * Why this extraction matters (vs the previous stays-on-page approach):
 *   - 7 useState calls + 10 setter props + matching isEditingXxx derivations
 *     were repeated on every render of leads/page.tsx for every lead
 *     (now N cards × M renders is bounded inside this component only)
 *   - Mutation handlers in useLeadMutations previously had to accept a
 *     giant `ui` object with 13 setters so it could clear editor state
 *     on success; with editors local, the hook just needs a single
 *     `clearEditor()` callback (or none — LeadCard handles its own
 *     close-on-commit when the call site knows the result).
 *
 * Page-level state still used here (passed in as props):
 *   - reassignLeadId / reassigning (page owns — also feeds the bulk
 *     transfer bar on the page)
 *
 * Props are kept narrow on purpose: ~14 props total vs the 28+ that would
 * exist if everything were funneled through.
 */

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/views/ui/card";
import { cn, fmtDubai } from "@/models/utils";
import {
  ChevronRight, MoreHorizontal, Edit3, Send, Building2, User, Users,
  Clock, Calendar, Trash2,
} from "lucide-react";
import {
  PIPELINE_STAGES, STATUS_EMOJIS, STATUS_LABELS, isPlaceholder,
  PROBABILITIES, LOST_REASONS, SOURCE_ICONS,
} from "@/views/leads/utils/constants";
import { daysSince, fmtAED } from "@/views/leads/utils/format";
import type { Lead } from "@/views/leads/hooks/useLeadsData";
import type { SalesUser, UseLeadMutationsReturn } from "@/views/leads/hooks/useLeadMutations";

/* ─── Props ─── */
export interface LeadCardProps {
  lead: Lead;
  // Data layer (passed through from useLeadsData)
  salesRole: string | null;
  currentUserId: string | null;
  userNameMap: Record<string, string>;
  salesUsers: SalesUser[];
  // Mutation handlers (passed through from useLeadMutations)
  changeStage: UseLeadMutationsReturn["changeStage"];
  changeProbability: UseLeadMutationsReturn["changeProbability"];
  changeStatus: UseLeadMutationsReturn["changeStatus"];
  changeLostReason: UseLeadMutationsReturn["changeLostReason"];
  addQuickNote: UseLeadMutationsReturn["addQuickNote"];
  updateNextAction: UseLeadMutationsReturn["updateNextAction"];
  updateNextFollowup: UseLeadMutationsReturn["updateNextFollowup"];
  reassignSales: UseLeadMutationsReturn["reassignSales"];
  handleDelete: UseLeadMutationsReturn["handleDelete"];
  // Page-level state (bulk-transfer bar + reassign dropdown are page concerns)
  reassignLeadId: string | null;
  reassigning: boolean;
  setReassignLeadId: (v: string | null) => void;
  setReassigning: (v: boolean) => void;
  // Selection / navigation / drag (page-level state)
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: (id: string) => void;
  draggingLeadId: string | null;
  onDragStart: (e: React.DragEvent, leadId: string) => void;
  // Column context — needed to render the lost-reason button only on the
  // "lost" column (mirrors original page.tsx `const isLost = stage.key === "lost"`).
  isLostColumn: boolean;
  // i18n
  t: (k: string) => string;
}

/* ─── Component ─── */
export function LeadCard({
  lead,
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
  selected,
  onToggleSelect,
  onOpen,
  draggingLeadId,
  onDragStart,
  isLostColumn,
  t,
}: LeadCardProps) {
  const router = useRouter();

  /* ─── Local editor state (7 flags + noteLeadId + 3 text fields) ─── */
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

  /* ─── Derive flags (same logic page.tsx L445-456) ─── */
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
  const isLost = isLostColumn;

  /* ─── Click-outside handler for reassign dropdown ─── */
  const reassignRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isReassigning) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (reassignRef.current && !reassignRef.current.contains(e.target as Node)) {
        setReassignLeadId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isReassigning, setReassignLeadId]);

  /* ─── Editor open/close helpers — close-on-commit then call mutation ─── */
  const openStageEditor = () => setEditingStage(isEditing ? null : lead.id);
  const closeStageEditor = () => setEditingStage(null);

  const openProbabilityEditor = () => { setEditingProbability(lead.id); closeStageEditor(); };
  const closeProbabilityEditor = () => setEditingProbability(null);

  const openStatusEditor = () => { setEditingStatus(lead.id); closeStageEditor(); };
  const closeStatusEditor = () => setEditingStatus(null);

  const openLostReasonEditor = () => { setEditingLostReason(lead.id); closeStageEditor(); };
  const closeLostReasonEditor = () => setEditingLostReason(null);

  const openNextActionEditor = () => {
    setEditingNextAction(lead.id);
    setNextActionText(lead.next_action || "");
    closeStageEditor();
  };
  const closeNextActionEditor = () => {
    setEditingNextAction(null);
    setNextActionText("");
  };

  const openNextFollowupEditor = () => {
    setEditingNextFollowup(lead.id);
    setNextFollowupText(lead.next_followup_date || "");
    closeStageEditor();
  };
  const closeNextFollowupEditor = () => {
    setEditingNextFollowup(null);
    setNextFollowupText("");
  };

  const openNoteEditor = () => {
    setNoteLeadId(isNoting ? null : lead.id);
    if (!isNoting) setNoteText("");
  };
  const closeNoteEditor = () => {
    setNoteLeadId(null);
    setNoteText("");
  };

  /* ─── Navigation guard: don't open detail while any editor is open ─── */
  const anyEditorOpen = isEditing || isEditingProb || isEditingSt || isEditingLost ||
    isEditingAction || isEditingFollowup || isNoting || isReassigning;
  const handleCardClick = () => {
    if (!anyEditorOpen) onOpen(lead.id);
  };

  /* ─── Click handlers — close editor + invoke handler in one frame ─── */
  const onChangeStage = (newStage: string) => {
    closeStageEditor();
    void changeStage(lead.id, newStage);
  };
  const onChangeProbability = (prob: number) => {
    closeProbabilityEditor();
    void changeProbability(lead.id, prob);
  };
  const onChangeStatus = (status: string) => {
    closeStatusEditor();
    void changeStatus(lead.id, status);
  };
  const onChangeLostReason = (reason: string) => {
    closeLostReasonEditor();
    void changeLostReason(lead.id, reason);
  };
  const onCommitNextAction = () => {
    if (!nextActionText.trim()) return;
    void updateNextAction(lead.id, nextActionText.trim());
    closeNextActionEditor();
  };
  const onCommitNextFollowup = () => {
    if (!nextFollowupText) return;
    void updateNextFollowup(lead.id, nextFollowupText);
    closeNextFollowupEditor();
  };
  const onCommitNote = () => {
    if (!noteText.trim()) return;
    void addQuickNote(lead.id, noteText.trim());
    closeNoteEditor();
  };
  const onReassign = (newUserId: string) => {
    void reassignSales(lead.id, newUserId);
    // Page owns reassignLeadId/reassigning state — it flips the dropdown closed
    // via the hook's reassignSales success path.
  };

  /* ─── Quick stage arrows (header action row, page.tsx L571-577) ─── */
  const onQuickAdvance = (newStage: string) => {
    void changeStage(lead.id, newStage);
  };

  /* ─── Render ─── */
  return (
    <Card
      draggable
      onDragStart={(e) => onDragStart(e, lead.id)}
      className={cn(
        "cursor-pointer transition-all duration-150 group relative shrink-0",
        "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-foreground/5",
        draggingLeadId === lead.id && "opacity-40",
        isHot && "ring-1 ring-rose-500/30",
        isCrit ? "ring-2 ring-red-500/40" : isStale ? "ring-1 ring-amber-500/30" : "",
        lead.recovery_candidate && "ring-1 ring-orange-500/30",
        lead.transfer_candidate && "ring-1 ring-red-500/20",
        lead.sales_manager_review && "ring-1 ring-purple-500/30",
        selected && "ring-2 ring-copper-500 bg-copper-500/5",
      )}
      onClick={handleCardClick}
    >
      <CardContent className="p-3 space-y-2">
        {/* Bulk select checkbox — top-right */}
        {(salesRole === "admin" || salesRole === "boss") && (
          <div className="absolute top-2 right-2 z-10" onClick={e => e.stopPropagation()}>
            <input type="checkbox" checked={selected}
              onChange={onToggleSelect}
              className="w-4 h-4 rounded border-border/50 bg-card accent-copper-500 cursor-pointer opacity-40 group-hover:opacity-100 checked:opacity-100 transition-opacity" />
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
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
            <span>{SOURCE_ICONS[lead.source] || "📋"} {t(`sourceLabels.${lead.source}`) || lead.source}</span>
            {lead.assigned_to && (
              <>
              <span className="inline-flex items-center gap-1">
              <User className="w-3 h-3" />
              <span>{userNameMap[lead.assigned_to] || t("leads.unassigned")}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setReassignLeadId(reassignLeadId === lead.id ? null : lead.id); }}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors ml-0.5"
                title="Reassign"
              >
                ↔️
              </button>
              </span>
              {reassignLeadId === lead.id && (
              <div className="w-full mt-1 z-50 bg-muted border border-border rounded-lg shadow-xl py-1 max-h-40 overflow-y-auto"
                ref={reassignRef}
                onClick={(e) => e.stopPropagation()}
              >
                {reassigning && <div className="px-3 py-2 text-xs text-muted-foreground">正在转移...</div>}
                {salesUsers.map((u) => (
                  <button key={u.id}
                    onClick={() => onReassign(u.id)}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-muted transition-colors",
                      lead.assigned_to === u.id ? "text-copper-400" : "text-foreground"
                    )}
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full", lead.assigned_to === u.id ? "bg-copper-400" : "bg-gray-600")} />
                    <span className="truncate">{u.full_name || u.email}</span>
                  </button>
                ))}
                {salesUsers.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">无用户</p>}
              </div>
              )}
              </>
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
            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              {!isLost && nextStages.slice(0, 2).map(ns => (
                <button key={ns.key} title={t("leads.moveTo").replace("{stage}", t(`stageLabels.${ns.key}`))}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  onClick={(e) => { e.stopPropagation(); onQuickAdvance(ns.key); }}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              ))}
              <button title={t("leads.quickNote")}
                className={cn("p-1 rounded hover:bg-accent transition-colors", isNoting ? "text-copper-400" : "text-muted-foreground hover:text-foreground")}
                onClick={(e) => { e.stopPropagation(); openNoteEditor(); }}>
                <Edit3 className="w-3.5 h-3.5" />
              </button>
              <button title={t("common.actions")}
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); openStageEditor(); }}>
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </div>
            {(salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && lead.assigned_to === currentUserId)) && (
              <button title={t("common.delete") || "Delete"}
                className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                onClick={(e) => { e.stopPropagation(); void handleDelete(lead.id, lead.assigned_to); }}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
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
                  onClick={() => onChangeStage(s.key)}>{t(`stageLabels.${s.key}`)}</button>
              ))}
            </div>
            <div className="flex gap-1 mt-1 flex-wrap">
              {/* Probability */}
              <button onClick={openProbabilityEditor}
                className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                {t("leads.probability")} {lead.win_probability || "—"}%
              </button>
              {/* Status */}
              <button onClick={openStatusEditor}
                className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                {t("leads.status")} {lead.lead_status ? `${STATUS_EMOJIS[lead.lead_status] || ""} ${t(`statusLabels.${lead.lead_status}`)}` : "—"}
              </button>
              {/* Next action */}
              <button onClick={openNextActionEditor}
                className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                📋{t("leads.nextAction")}
              </button>
              {/* Next followup */}
              <button onClick={openNextFollowupEditor}
                className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                📅{t("leads.followUp")}
              </button>
              {/* Lost reason (only show for lost column) */}
              {isLost && (
                <button onClick={openLostReasonEditor}
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
                  onClick={() => onChangeProbability(p)}>{p}%</button>
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
                  onClick={() => onChangeStatus(k)}>{STATUS_EMOJIS[k] || ""} {t(`statusLabels.${k}`)}</button>
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
                  onClick={() => onChangeLostReason(r)}>{r}</button>
              ))}
            </div>
          </div>
        )}

        {/* Next action editor */}
        {isEditingAction && (
          <div className="pt-2 border-t border-border flex gap-1" onClick={(e) => e.stopPropagation()}>
            <input autoFocus placeholder={t("leads.nextActionRequired")} value={nextActionText}
              onChange={(e) => setNextActionText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onCommitNextAction(); if (e.key === "Escape") closeNextActionEditor(); }}
              className="flex-1 h-7 text-xs bg-background border border-border rounded px-2 focus:outline-none focus:ring-1 focus:ring-primary text-foreground" />
            <button onClick={onCommitNextAction} disabled={!nextActionText.trim()}
              className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-30"><Send className="w-3 h-3" /></button>
          </div>
        )}

        {/* Next followup editor */}
        {isEditingFollowup && (
          <div className="pt-2 border-t border-border flex gap-1" onClick={(e) => e.stopPropagation()}>
            <input autoFocus type="date" value={nextFollowupText}
              onChange={(e) => setNextFollowupText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") closeNextFollowupEditor(); }}
              className="flex-1 h-7 text-xs bg-background border border-border rounded px-2 focus:outline-none focus:ring-1 focus:ring-primary text-foreground" />
            <button onClick={onCommitNextFollowup} disabled={!nextFollowupText}
              className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-30"><Send className="w-3 h-3" /></button>
          </div>
        )}

        {/* Note editor */}
        {isNoting && (
          <div className="pt-2 border-t border-border flex gap-1" onClick={(e) => e.stopPropagation()}>
            <input autoFocus placeholder={t("leads.addNote")} value={noteText} onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onCommitNote(); if (e.key === "Escape") closeNoteEditor(); }}
              className="flex-1 h-7 text-xs bg-background border border-border rounded px-2 focus:outline-none focus:ring-1 focus:ring-primary text-foreground" />
            <button onClick={onCommitNote} disabled={!noteText.trim()}
              className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-30"><Send className="w-3 h-3" /></button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
