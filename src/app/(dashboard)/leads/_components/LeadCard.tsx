"use client";

/**
 * Compact pipeline card: identity, one next-action signal, and necessary controls.
 * Complete workflow edits remain in the Lead detail page.
 */

import { translatedOrRaw } from "@/lib/chart-labels.mjs";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AlertTriangle, Building2, Clock, Trash2, User, Users,
} from "lucide-react";
import {
  PIPELINE_STAGES, STATUS_LABELS, isPlaceholder,
} from "../_utils/constants";
import { daysSince, fmtAED } from "../_utils/format";
import { isWaitingForReply, isWhatsAppAdLead } from "@/lib/whatsapp-ad-display.mjs";
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
  const isCrit = days !== null && days >= 14 && !lead.final_status;
  const isReassigning = reassignLeadId === lead.id;
  const statusStyle = STATUS_LABELS[lead.lead_status || ""];
  const stageIdx = PIPELINE_STAGES.findIndex((stage) => stage.key === lead.stage);
  const stageAtLeast = (stage: string) =>
    stageIdx >= PIPELINE_STAGES.findIndex((item) => item.key === stage);

  const actionPrompt = (() => {
    if (lead.final_status || ["won", "lost"].includes(lead.stage)) return null;

    if (lead.next_followup_date && lead.next_followup_date < new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" })) {
      return { label: t("leads.actionOverdue"), urgent: true };
    }

    if (lead.stage === "new") {
      if (!lead.last_contact_date) return { label: t("leads.actionFirstContact"), urgent: false };
      if (!lead.quality || lead.quality === "pending") {
        return { label: t("leads.actionQuality"), urgent: false };
      }
    }

    if (stageAtLeast("contacted") && !lead.phone) {
      return { label: t("leads.actionPhone"), urgent: false };
    }

    if (stageAtLeast("requirement_confirmed")) {
      const missingRequirements = [
        isPlaceholder(lead.project_type) ? t("leads.actionProjectType") : null,
        isPlaceholder(lead.project_status) ? t("leads.actionProjectStatus") : null,
        isPlaceholder(lead.location) ? t("leads.actionLocation") : null,
      ].filter((item): item is string => item !== null);
      if (missingRequirements.length > 0) {
        const suffix = missingRequirements.length > 1
          ? t("leads.actionMissingMore").replace(
              "{count}",
              String(missingRequirements.length - 1),
            )
          : "";
        return {
          label: `${missingRequirements[0]}${suffix}`,
          urgent: false,
        };
      }
    }

    if (
      stageAtLeast("quotation_submitted")
      && !(lead.quotation_value && lead.quotation_value > 0)
    ) {
      return { label: t("leads.actionQuotationValue"), urgent: false };
    }

    if (!lead.next_action) return { label: t("leads.actionNextAction"), urgent: false };
    if (!lead.next_followup_date) return { label: t("leads.actionFollowupDate"), urgent: false };

    const nextActionKey = `leads.nextActionLabels.${lead.next_action}`;
    return {
      label: t("leads.actionNext").replace(
        "{action}",
        translatedOrRaw(t, nextActionKey, lead.next_action),
      ),
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
      data-lead-id={lead.id}
      onDragStart={(e) => onDragStart(e, lead.id)}
      className={cn(
        "cursor-pointer transition-all duration-150 group relative shrink-0",
        "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-foreground/5",
        draggingLeadId === lead.id && "opacity-40",
        isCrit && "ring-1 ring-red-600/40",
        selected && "ring-2 ring-copper-500 bg-copper-500/5",
      )}
      onClick={handleCardClick}
    >
      <CardContent className="p-3 space-y-2">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-medium text-foreground truncate max-w-[180px]">{!isPlaceholder(lead.customer_name) ? lead.customer_name : (lead.phone || t("common.unnamed"))}</p>
              {statusStyle && <span className={cn("text-xs px-1 py-0.5 rounded font-medium", statusStyle.bg, statusStyle.color)}>{t(`statusLabels.${lead.lead_status || ""}`)}</span>}
              {isWhatsAppAdLead(lead) && (
                <span data-testid="whatsapp-ad-badge" className="text-xs px-1 py-0.5 rounded font-medium bg-emerald-500/10 text-emerald-700">{t("s37.wa.badge")}</span>
              )}
              {isWaitingForReply(lead) && (
                <span data-testid="whatsapp-waiting-badge" className="text-xs px-1 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400">{t("s39.list.waitingReply")}</span>
              )}
            </div>
            {(!isPlaceholder(lead.property_type) || !isPlaceholder(lead.location)) && (
              <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground mt-0.5">
                <Building2 className="w-3 h-3 shrink-0" /><span className="min-w-0 truncate">{[lead.property_type, lead.location].filter(v => !isPlaceholder(v)).join(" · ")}</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-start gap-2">
            {lead.quotation_value != null && lead.quotation_value > 0 && (
              <span className="text-xs font-semibold text-copper-700">{fmtAED(lead.quotation_value)}</span>
            )}
            {(salesRole === "admin" || salesRole === "boss") && (
              <div className="flex h-5 items-center" onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={selected}
                  onChange={onToggleSelect}
                  aria-label={t("s42.a11y.selectLead").replace("{name}", !isPlaceholder(lead.customer_name) ? String(lead.customer_name) : (lead.phone || t("common.unnamed")))}
                  className="h-6 w-6 rounded border-border/50 bg-card accent-copper-500 cursor-pointer opacity-40 group-hover:opacity-100 checked:opacity-100 transition-opacity" />
              </div>
            )}
          </div>
        </div>

        {/* One action-oriented signal; open detail for the complete workflow. */}
        {actionPrompt && (
          <div
            data-testid="lead-card-action-prompt"
            className={cn(
              "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs",
              actionPrompt.urgent
                ? "bg-amber-100 text-amber-800"
                : "bg-muted/60 text-muted-foreground"
            )}
            title={t("leads.actionOpenDetail")}
          >
            {actionPrompt.urgent
              ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              : <Clock className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{actionPrompt.label}</span>
          </div>
        )}

        {/* Bottom info row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <span>{translatedOrRaw(t, `sourceLabels.${lead.source}`, lead.source)}</span>
            {lead.assigned_to && (
              <>
                <span data-newme-uat-sensitive="true" className="inline-flex items-center gap-1 min-w-0">
                  <User className="w-3 h-3 shrink-0" />
                  <span className="truncate">{userNameMap[lead.assigned_to] || t("leads.unassigned")}</span>
                </span>
                <button
                  ref={reassignButtonRef}
                  onClick={toggleReassign}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors hover:bg-muted/70"
                  title={t("leads.transfer")}
                  aria-label={t("leads.transfer")}
                  aria-expanded={isReassigning}
                >
                  <Users className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {days !== null && (
              <span className={cn("text-xs flex items-center gap-0.5",
                isCrit ? "text-red-700 font-semibold" : "text-muted-foreground"
              )}>
                <Clock className="w-3 h-3" />{days === 0 ? t("common.today") : t("common.nDays").replace("{n}", String(days))}
              </span>
            )}
            {(salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && lead.assigned_to === currentUserId)) && (
              <button title={t("common.delete") || "Delete"}
                className="hidden h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-700 group-hover:inline-flex"
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
            {reassigning && <div className="px-3 py-2 text-xs text-muted-foreground">{t("leadDetail.reassigning")}</div>}
            {salesUsers.map((user) => (
              <button
                key={user.id}
                onClick={() => onReassign(user.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                  lead.assigned_to === user.id ? "text-copper-700" : "text-foreground"
                )}
              >
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  lead.assigned_to === user.id ? "bg-copper-400" : "bg-gray-600"
                )} />
                <span data-newme-uat-sensitive="true" className="truncate">{user.full_name || user.email}</span>
              </button>
            ))}
            {salesUsers.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{t("leads.noUsers")}</p>}
          </div>,
          document.body
        )}
      </CardContent>
    </Card>
  );
}
