"use client";

import { useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { toast } from "sonner";
import { PIPELINE_STAGES } from "@/shared/kanban/types";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { leadHasWonAmount, submitStageFromDrag } from "@/lib/won-drag.mjs";

// ─── Types ───
interface LeadBase {
  id: string;
  stage: string;
  final_status?: string | null;
  [key: string]: any;
}

interface UsePipelineDragDropReturn {
  onDragStart: (e: React.DragEvent, leadId: string) => void;
  onDragOver: (e: React.DragEvent, stageKey: string) => void;
  onDragLeave: (stageKey: string) => void;
  onDragEnter: (stageKey: string) => void;
  onDrop: (e: React.DragEvent, targetStage: string) => Promise<void>;
  draggingLeadId: string | null;
  draggingOverStage: string | null;
  /** Set while a lead dropped on Won (note + amount) or Lost (reason) waits for its dialog; render it with WonDropDialog. */
  wonPrompt: WonPrompt | null;
  wonSaving: boolean;
  confirmWon: (note: string, amount: string) => Promise<void>;
  cancelWon: () => void;
}

export interface WonPrompt {
  /** Which closing stage the drop asked for; lost needs a reason (the note) and never an amount. */
  stage: "won" | "lost";
  /** Created once when the dialog opens and reused by every retry of this dialog, so a repeated confirm never applies twice. */
  idempotencyKey: string;
  leadId: string;
  name: string;
  /** The lead has no amount yet (or the server asked for one): the dialog shows the amount field. */
  needsAmount: boolean;
  error: string | null;
}

const STAGE_INDEX: Record<string, number> = {};
PIPELINE_STAGES.forEach((s, i) => { STAGE_INDEX[s.key] = i; });

// ─── usePipelineDragDrop Hook ───
// Generic hook that works with any Lead type extending LeadBase.
// Handles optimistic updates, Supabase persistence, activity logging, and rollback on error.
export function usePipelineDragDrop<T extends LeadBase>(
  leads: T[],
  setLeads: React.Dispatch<React.SetStateAction<T[]>>,
  currentUserId: string | null
): UsePipelineDragDropReturn {
  const { lang } = useLanguage();
  const [draggingLeadId, setDraggingLeadId] = useState<string | null>(null);
  const [draggingOverStage, setDraggingOverStage] = useState<string | null>(null);
  const dragCounter = useRef<Record<string, number>>({});
  const [wonPrompt, setWonPrompt] = useState<WonPrompt | null>(null);
  const [wonSaving, setWonSaving] = useState(false);

  // ─── Drag Start ───
  const onDragStart = useCallback((e: React.DragEvent, leadId: string) => {
    e.dataTransfer.setData("text/plain", leadId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingLeadId(leadId);
  }, []);

  // ─── Drag Over ───
  const onDragOver = useCallback((e: React.DragEvent, stageKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDraggingOverStage(stageKey);
  }, []);

  // ─── Drag Enter ───
  const onDragEnter = useCallback((stageKey: string) => {
    dragCounter.current[stageKey] = (dragCounter.current[stageKey] || 0) + 1;
  }, []);

  // ─── Drag Leave ───
  const onDragLeave = useCallback((stageKey: string) => {
    dragCounter.current[stageKey] = (dragCounter.current[stageKey] || 0) - 1;
    if (dragCounter.current[stageKey] <= 0) {
      dragCounter.current[stageKey] = 0;
      setDraggingOverStage(prev => prev === stageKey ? null : prev);
    }
  }, []);

  // ─── Drop ───
  const onDrop = useCallback(async (e: React.DragEvent, targetStage: string) => {
    e.preventDefault();
    setDraggingOverStage(null);
    setDraggingLeadId(null);

    const leadId = e.dataTransfer.getData("text/plain");
    if (!leadId) return;

    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    // ─── Stage Guard ───
    // Same stage → no-op
    if (lead.stage === targetStage) return;

    // Valid target stage
    if (!(targetStage in STAGE_INDEX)) {
      toast.error(`${lang === "zh" ? "无效的阶段" : "Invalid stage"}: "${targetStage}"`);
      return;
    }

    // Terminal leads can't be moved (won/lost in final_status)
    if (lead.final_status === "won" || lead.final_status === "lost") {
      toast.error(lang === "zh" ? "无法移动已关闭的客户" : "Cannot move closed leads");
      return;
    }

    // Won and Lost are never written from the browser: they go through the same server route as the lead page (Won: amount
    // required; Lost: reason required; audited stage change, Meta events queued). The drop opens the dialog; confirmWon sends it.
    if (targetStage === "won" || targetStage === "lost") {
      setWonPrompt({
        stage: targetStage,
        idempotencyKey: crypto.randomUUID(),
        leadId,
        name: String(lead.customer_name ?? lead.name ?? ""),
        needsAmount: targetStage === "won" && !leadHasWonAmount(lead),
        error: null,
      });
      return;
    }

    // ─── Optimistic Update ───
    const oldStage = lead.stage;
    const oldFinal = lead.final_status;

    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, stage: targetStage } : l));

    // ─── Persist to Supabase ───
    const supabase = createClient();
    const now = new Date().toISOString();
    const updates: import("@/types/database").Database["public"]["Tables"]["leads"]["Update"] = { stage: targetStage, updated_at: now, last_contact_date: now };

    const { error: updateErr } = await supabase.from("leads").update(updates).eq("id", leadId);

    if (updateErr) {
      // Rollback optimistic update
      setLeads(prev => prev.map(l => l.id === leadId ? { ...l, stage: oldStage, final_status: oldFinal } : l));
      toast.error(`${lang === "zh" ? "阶段更新失败" : "Stage update failed"}: ${updateErr.message}`);
      return;
    }

    // ─── Log activity ───
    await supabase.from("activities").insert({
      lead_id: leadId,
      type: "stage_change",
      content: `Stage changed from ${oldStage} to ${targetStage} (Kanban drag)`,
      user_id: currentUserId,
    });

    // ─── Log business event ───
    await supabase.from("business_events").insert({
      lead_id: leadId,
      event_type: "stage_change",
      description: `Stage changed from ${oldStage} to ${targetStage} via Kanban drag-drop`,
      event_data: { from: oldStage, to: targetStage },
      user_id: currentUserId,
    });

    toast.success(`${lang === "zh" ? "已移动到" : "Moved to"} ${PIPELINE_STAGES.find(s => s.key === targetStage)?.label || targetStage}`);
  }, [leads, setLeads, currentUserId, lang]);

  // ─── Won / Lost (through the server route) ───
  const confirmWon = useCallback(async (note: string, amount: string) => {
    if (!wonPrompt || wonSaving) return;
    const { leadId, stage, idempotencyKey } = wonPrompt;
    setWonSaving(true);
    try {
      const result = await submitStageFromDrag(fetch, leadId, { stage, note, amount, idempotencyKey });
      if (!result.ok) {
        const reasons = (lang === "zh" ? result.reasons_zh : result.reasons) ?? [];
        const message = reasons.length ? reasons.join("；") : (lang === "zh" ? result.error_zh : result.error);
        setWonPrompt(prev => prev && { ...prev, needsAmount: prev.needsAmount || result.needsAmount, error: message });
        return;
      }
      const typed = Number(amount.replace(/,/g, "").trim());
      setLeads(prev => prev.map(l => l.id === leadId ? {
        ...l,
        stage: result.lead?.stage ?? stage,
        final_status: stage,
        ...(stage === "won" && !leadHasWonAmount(l) && typed > 0 ? { quotation_value: typed } : {}),
      } : l));
      setWonPrompt(null);
      toast.success(`${lang === "zh" ? "已移动到" : "Moved to"} ${PIPELINE_STAGES.find(s => s.key === stage)?.label || stage}`);
    } finally {
      setWonSaving(false);
    }
  }, [wonPrompt, wonSaving, setLeads, lang]);

  const cancelWon = useCallback(() => { if (!wonSaving) setWonPrompt(null); }, [wonSaving]);

  return {
    onDragStart,
    onDragOver,
    onDragLeave,
    onDragEnter,
    onDrop,
    draggingLeadId,
    draggingOverStage,
    wonPrompt,
    wonSaving,
    confirmWon,
    cancelWon,
  };
}
