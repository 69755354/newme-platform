"use client";

/**
 * LeadCard — T3-3 step 1 extracted from pipeline/page.tsx
 *
 * Draggable kanban card for a single Lead. Pure component extraction,
 * zero business-logic changes. Renders value, probability, next action,
 * assigned rep, and stale-day badge with color tiers.
 */

import { useLanguage } from "@/views/i18n/LanguageContext";
import { cn } from "@/models/utils";
import { GripVertical, User, Clock } from "lucide-react";

/* ─── Lead shape (subset used by this component) ─── */
export interface Lead {
  id: string; customer_name: string | null;
  stage: string; final_status: string | null; quotation_value: number | null;
  win_probability: number | null;
  last_contact_date: string | null; next_followup_date: string | null;
  next_action: string | null; created_at: string; updated_at: string;
  recovery_candidate: boolean; transfer_candidate: boolean;
  sales_manager_review: boolean; hold_since: string | null;
  lead_status: string | null; assigned_to: string | null;
  rep_name: string | null;
  followup_count: number | null;
}

const STATUS_EMOJIS: Record<string, string> = {
  hot: "🔥", warm: "☀️", cold: "❄️", dormant: "💤",
};

function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

function daysSince(d: string | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

/* ─── Draggable Lead Card ─── */
export function LeadCard({ lead, onDragStart, onLeadClick, salesUsers }: { lead: Lead; onDragStart: (e: React.DragEvent, leadId: string) => void; onLeadClick: (id: string) => void; salesUsers: any[] }) {
  const { t } = useLanguage();
  const days = daysSince(lead.last_contact_date || lead.updated_at);
  const hoursSinceUpdate = lead.updated_at
    ? Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / 3_600_000)
    : null;
  const isInactive24h = hoursSinceUpdate !== null && hoursSinceUpdate >= 24 && !lead.final_status;
  const isStale = days !== null && days > 7 && !lead.final_status;
  const isCrit = days !== null && days >= 14 && !lead.final_status;
  const isHot = lead.lead_status === "hot";
  const isWon = lead.final_status === "won";
  const isLost = lead.final_status === "lost";

  return (
    <div
      draggable
      onDragStart={(e) => {
        (e.currentTarget as HTMLElement).classList.add("opacity-40");
        onDragStart(e, lead.id);
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).classList.remove("opacity-40");
      }}
      onClick={() => onLeadClick(lead.id)}
        className={cn(
        "p-3 rounded-lg border bg-muted/60 cursor-grab active:cursor-grabbing transition-all duration-150 select-none",
        "hover:bg-muted/80 hover:border-border",
        "group relative",
        isHot && "ring-1 ring-slate-600/30",
        isInactive24h && !isStale && "ring-1 ring-amber-500/20",
        isCrit ? "ring-2 ring-red-500/40" : isStale ? "ring-1 ring-amber-500/30" : "border-border",
        isWon && "border-emerald-700/50 bg-emerald-950/20",
        isLost && "border-border/30 bg-muted/40",
      )}
    >
      {/* Drag handle - always visible */}
      <div className="absolute top-1 right-1 opacity-40 group-hover:opacity-80 transition-opacity pointer-events-none">
        <GripVertical className="w-4 h-4 text-muted-foreground" />
      </div>

      {/* Customer name */}
      <div className="flex items-center gap-1.5 mb-1.5 pr-4">
        {isHot && <span className="text-[10px]">🔥</span>}
        <span className="text-sm font-medium text-foreground truncate flex-1">
          {lead.customer_name || t("common.unnamed")}
        </span>
        {lead.lead_status && (
          <span className="text-[9px]">{STATUS_EMOJIS[lead.lead_status]}</span>
        )}
      </div>

      {/* Value & Probability */}
      <div className="flex items-center gap-2 mb-1.5">
        {lead.quotation_value != null && lead.quotation_value > 0 && (
          <span className="text-xs font-semibold text-copper-400">{fmtAED(lead.quotation_value)}</span>
        )}
        {lead.win_probability != null && (
          <span className={cn("text-[10px] font-medium",
            lead.win_probability >= 70 ? "text-emerald-400" :
            lead.win_probability >= 30 ? "text-amber-400" : "text-muted-foreground"
          )}>
            {lead.win_probability}%
          </span>
        )}
      </div>

      {/* Next action */}
      {lead.next_action && (
        <p className="text-[10px] text-muted-foreground truncate mb-1">📋 {lead.next_action}</p>
      )}

      {/* Footer: assigned + stale days */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="flex items-center gap-0.5 truncate">
          <User className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{lead.rep_name || (salesUsers.find(u => u.id === lead.assigned_to)?.full_name) || "—"}</span>
        </span>
        {days !== null && !isWon && !isLost && (
          <span className={cn("flex items-center gap-1",
            isCrit ? "text-red-400 font-semibold" : isStale ? "text-amber-400" : "text-muted-foreground"
          )}>
            {isInactive24h && !isStale && <Clock className="w-2.5 h-2.5" />}
            {days}d
          </span>
        )}
        {isInactive24h && !isStale && days === null && (
          <span className="text-amber-400 text-[10px] flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />24h</span>
        )}
      </div>
    </div>
  );
}
