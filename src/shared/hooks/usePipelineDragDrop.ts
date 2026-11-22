"use client";

import { useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { toast } from "sonner";
import { PIPELINE_STAGES, TERMINAL_STAGES } from "@/shared/kanban/types";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { leadHasWonAmount, submitWonFromDrag } from "@/lib/won-drag.mjs";

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
  /** Set while a lead dropped on Won waits for its note (and amount); render it with WonDropDialog. */
  wonPrompt: WonPrompt | null;
  wonSaving: boolean;
  confirmWon: (note: string, amount: string) => Promise<void>;
  cancelWon: () => void;
}

export interface WonPrompt {
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

    // Won is never written from the browser: it goes through the same server route as the lead page (amount required,
    // audited stage change, Won / Purchase events queued). The drop opens the note + amount dialog; confirmWon sends it.
    if (targetStage === "won") {
      setWonPrompt({
        leadId,
        name: String(lead.customer_name ?? lead.name ?? ""),
        needsAmount: !leadHasWonAmount(lead),
        error: null,
      });
      return;
    }

    // ─── Optimistic Update ───
    const oldStage = lead.stage;
    const oldFinal = lead.final_status;

    setLeads(prev => prev.map(l => l.id === leadId ? {
      ...l,
      ...(targetStage === "won" || targetStage === "lost"
        ? { final_status: targetStage }
        : { stage: targetStage })
    } : l));

    // ─── Persist to Supabase ───
    const supabase = createClient();
    const now = new Date().toISOString();
    const updates: import("@/types/database").Database["public"]["Tables"]["leads"]["Update"] = targetStage === "won" || targetStage === "lost"
      ? { final_status: targetStage, updated_at: now, last_contact_date: now }
      : { stage: targetStage, updated_at: now, last_contact_date: now };

    if (TERMINAL_STAGES.has(targetStage)) {
      updates.decision_date = now;
      // Cascade: close related open quotes
      await supabase.from("quotations")
        .update({ status: targetStage === "lost" ? "draft" : undefined, updated_at: now })
        .eq("lead_id", leadId)
        .neq("status", "accepted");
    }

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

  // ─── Won (through the server route) ───
  const confirmWon = useCallback(async (note: string, amount: string) => {
    if (!wonPrompt || wonSaving) return;
    const { leadId } = wonPrompt;
    setWonSaving(true);
    try {
      const result = await submitWonFromDrag(fetch, leadId, { note, amount, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) {
        const message = lang === "zh" ? result.error_zh : result.error;
        setWonPrompt(prev => prev && { ...prev, needsAmount: prev.needsAmount || result.needsAmount, error: message });
        return;
      }
      const typed = Number(amount.replace(/,/g, "").trim());
      setLeads(prev => prev.map(l => l.id === leadId ? {
        ...l,
        stage: result.lead?.stage ?? "won",
        final_status: "won",
        ...(!leadHasWonAmount(l) && typed > 0 ? { quotation_value: typed } : {}),
      } : l));
      setWonPrompt(null);
      toast.success(`${lang === "zh" ? "已移动到" : "Moved to"} ${PIPELINE_STAGES.find(s => s.key === "won")?.label || "won"}`);
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
