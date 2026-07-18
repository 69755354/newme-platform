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

import { useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AlertTriangle, Building2, Clock, Trash2, User, Users,
} from "lucide-react";
import {
  PIPELINE_STAGES, STATUS_EMOJIS, STATUS_LABELS, isPlaceholder, SOURCE_ICONS,
} from "../_utils/constants";
import { daysSince, fmtAED } from "../_utils/format";
import type { Lead } from "../_hooks/useLeadsData";
import type { SalesUser, UseLeadMutationsReturn } from "../_hooks/useLeadMutations";

/* ─── Props ─── */
export interface LeadCardProps {
  lead: Lead;
  // Data layer (passed through from useLeadsData)
  salesRole: string | null;
  currentUserId: string | null;
  userNameMap: Record<string, string>;
  salesUsers: SalesUser[];
  // Mutation handlers (passed through from useLeadMutations)
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
  t,
}: LeadCardProps) {
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
  const stageIdx = PIPELINE_STAGES.findIndex(s => s.key === lead.s  /* ─── One action signal per card ─── */
  const days = daysSince(lead.last_contact_date || lead.updated_at);
  const isHot = lead.lead_status === "hot";
  const isStale = days !== null && days > 7 && !lead.final_status;
  const isCrit = days !== null && days >= 14 && !lead.final_status;
  const statusStyle = STATUS_LABELS[lead.lead_status || ""];
  const stageIdx = PIPELINE_STAGES.findIndex((stage) => stage.key === lead.stage);
  const stageAtLeast = (stage: string) =>
    stageIdx >= PIPELINE_STAGES.findIndex((item) => item.key === stage);

  const actionPrompt = (() => {
    if (lead.final_status || ["won", "lost"].includes(lead.stage)) return null;

    if (lead.stage === "new") {
      if (!lead.last_contact_date || (lead.followup_count ?? 0) < 1) {
        return { label: "待完成：联系记录", urgent: true };
      }
      if (!lead.quality) return { label: "待评估：线索质量", urgent: true };
    }

    if (stageAtLeast("contacted") && !lead.phone) {
      return { label: "待完善：联系电话", urgent: true };
    }

    if (stageAtLeast("requirement_confirmed")) {
      const missingProjectType = isPlaceholder(lead.property_type);
      const missingLocation = isPlaceholder(lead.location);
      if (missingProjectType && missingLocation) {
        return { label: "待完善：项目类型与地址", urgent: true };
      }
      if (missingProjectType) return { label: "待完善：项目类型", urgent: true };
      if (missingLocation) return { label: "待完善：项目地址", urgent: true };
    }

    if (
      stageAtLeast("quotation_submitted")
      && !(lead.quotation_value && lead.quotation_value > 0)
    ) {
      return { label: "待完善：报价金额", urgent: true };
    }

    if (lead.next_followup_date && new Date(lead.next_followup_date) < new Date()) {
      return { label: "跟进已逾期", urgent: true };
    }

    if (!lead.next_action) return { label: "待设置：下一步行动", urgent: true };

    return {
      label: `下一步：${t(`leads.nextActionLabels.${lead.next_action}`) || lead.next_action}`,
      urgent: false,
    };
  })();

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

  const handleCardClick = () => {
    if (!isReassigning) onOpen(lead.id);
  };

  const onReassign = (newUserId: string) => {
    void reassignSales(lead.id, newUserId);
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

        {/* One action-oriented signal; clicking the card opens the complete workflow. */}
        {actionPrompt && (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px]",
              actionPrompt.urgent
                ? "bg-amber-500/10 text-amber-600"
                : "bg-muted/60 text-muted-foreground"
            )}
            title="打开详情完善"
          >
            {actionPrompt.urgent
              ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              : <Clock className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{actionPrompt.label}</span>
          </div>
        )}

        {/* Bottom info row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
            <span>{SOURCE_ICONS[lead.source] || "📋"} {t(`sourceLabels.${lead.source}`) || lead.source}</span>
            {lead.assigned_to && (
              <>
                <span className="inline-flex items-center gap-1 min-w-0">
                  <User className="w-3 h-3 shrink-0" />
                  <span className="truncate">{userNameMap[lead.assigned_to] || t("leads.unassigned")}</span>
                </span>
                <div className="relative shrink-0" ref={reassignRef}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setReassignLeadId(reassignLeadId === lead.id ? null : lead.id); }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
                    title="转移销售"
                    aria-label="转移销售"
                  >
                    <Users className="h-4 w-4" />
                  </button>
                  {reassignLeadId === lead.id && (
                    <div
                      className="absolute left-0 top-full mt-1 z-50 w-56 bg-muted border border-border rounded-lg shadow-xl py-1 max-h-48 overflow-y-auto"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {reassigning && <div className="px-3 py-2 text-xs text-muted-foreground">正在转移...</div>}
                      {salesUsers.map((u) => (
                        <button key={u.id}
                          onClick={() => onReassign(u.id)}
                          className={cn(
                            "w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted transition-colors",
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
                </div>
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
            {(salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && lead.assigned_to === currentUserId)) && (
              <button title={t("common.delete") || "Delete"}
                className="hidden h-8 w-8 items-center justify-center rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors shrink-0 group-hover:inline-flex"
                onClick={(e) => { e.stopPropagation(); void handleDelete(lead.id, lead.assigned_to); }}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
