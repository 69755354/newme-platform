"use client";

/**
 * Compact pipeline card: identity, one next-action signal, and necessary controls.
 * Complete workflow edits remain in the Lead detail page.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  selected,
  onToggleSelect,
  onOpen,
  draggingLeadId,
  onDragStart,
  t,
}: LeadCardProps) {
  const days = daysSince(lead.last_contact_date || lead.updated_at);
  const isHot = lead.lead_status === "hot";
  const isStale = days !== null && days > 7 && !lead.final_status;
  const isCrit = days !== null && days >= 14 && !lead.final_status;
  const isReassigning = reassignLeadId === lead.id;
  const statusStyle = STATUS_LABELS[lead.lead_status || ""];
  const stageIdx = PIPELINE_STAGES.findIndex((stage) => stage.key === lead.stage);
  const stageAtLeast = (stage: string) =>
    stageIdx >= PIPELINE_STAGES.findIndex((item) => item.key === stage);

  const actionPrompt = (() => {
    if (lead.final_status || ["won", "lost"].includes(lead.stage)) return null;

    if (lead.next_followup_date && lead.next_followup_date < new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" })) {
      return { label: "跟进已逾期", urgent: true };
    }

    if (lead.stage === "new") {
      if (!lead.last_contact_date) return { label: "待记录首次联系", urgent: true };
      if (!lead.quality) return { label: "待评估线索质量", urgent: true };
    }

    if (stageAtLeast("contacted") && !lead.phone) {
      return { label: "待完善：联系电话", urgent: true };
    }

    if (stageAtLeast("requirement_confirmed")) {
      const missingRequirements = [
        isPlaceholder(lead.project_type) ? "项目类型" : null,
        isPlaceholder(lead.project_status) ? "项目状态" : null,
        isPlaceholder(lead.location) ? "地址" : null,
      ].filter((item): item is string => item !== null);
      if (missingRequirements.length > 0) {
        const suffix = missingRequirements.length > 1
          ? `等${missingRequirements.length}项`
          : "";
        return {
          label: `待完善：${missingRequirements[0]}${suffix}`,
          urgent: true,
        };
      }
    }

    if (
      stageAtLeast("quotation_submitted")
      && !(lead.quotation_value && lead.quotation_value > 0)
    ) {
      return { label: "待完善：报价金额", urgent: true };
    }

    if (!lead.next_action) return { label: "待填写下一步行动", urgent: true };
    if (!lead.next_followup_date) return { label: "待安排跟进日期", urgent: true };

    return {
      label: `下一步：${t(`leads.nextActionLabels.${lead.next_action}`) || lead.next_action}`,
      urgent: false,
    };
  })();

  const reassignButtonRef = useRef<HTMLButtonElement>(null);
  const reassignMenuRef = useRef<HTMLDivElement>(null);
  const [reassignPosition, setReassignPosition] = useState({ left: 8, top: 8 });

  useEffect(() => {
    if (!isReassigning) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !reassignButtonRef.current?.contains(target)
        && !reassignMenuRef.current?.contains(target)
      ) {
        setReassignLeadId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isReassigning, setReassignLeadId]);

  const handleCardClick = () => {
    if (!isReassigning) onOpen(lead.id);
  };

  const toggleReassign = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (isReassigning) {
      setReassignLeadId(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 224;
    const menuHeight = 192;
    setReassignPosition({
      left: Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8),
      top: rect.bottom + menuHeight < window.innerHeight
        ? rect.bottom + 4
        : Math.max(8, rect.top - menuHeight - 4),
    });
    setReassignLeadId(lead.id);
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
              {statusStyle && <span className={cn("text-[9px] px-1 py-0.5 rounded font-medium", statusStyle.bg, statusStyle.color)}>{STATUS_EMOJIS[lead.lead_status || ""] || ""} {t(`statusLabels.${lead.lead_status || ""}`)}</span>}
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

        {/* One action-oriented signal; open detail for the complete workflow. */}
        {actionPrompt && (
          <div
            data-testid="lead-card-action-prompt"
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
                <button
                  ref={reassignButtonRef}
                  onClick={toggleReassign}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 transition-colors hover:bg-blue-500/20"
                  title="转移销售"
                  aria-label="转移销售"
                  aria-expanded={isReassigning}
                >
                  <Users className="h-4 w-4" />
                </button>
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
                className="hidden h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400 group-hover:inline-flex"
                onClick={(event) => { event.stopPropagation(); void handleDelete(lead.id, lead.assigned_to); }}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {isReassigning && createPortal(
          <div
            ref={reassignMenuRef}
            className="fixed z-[1000] max-h-48 w-56 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-xl"
            style={{ left: reassignPosition.left, top: reassignPosition.top }}
            onClick={(event) => event.stopPropagation()}
          >
            {reassigning && <div className="px-3 py-2 text-xs text-muted-foreground">正在转移...</div>}
            {salesUsers.map((user) => (
              <button
                key={user.id}
                onClick={() => onReassign(user.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                  lead.assigned_to === user.id ? "text-copper-400" : "text-foreground"
                )}
              >
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  lead.assigned_to === user.id ? "bg-copper-400" : "bg-gray-600"
                )} />
                <span className="truncate">{user.full_name || user.email}</span>
              </button>
            ))}
            {salesUsers.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">无用户</p>}
          </div>,
          document.body
        )}
      </CardContent>
    </Card>
  );
}
