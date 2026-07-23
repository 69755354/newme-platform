"use client";

/**
 * useLeadMutations — T3-3 step 6 extracted from leads/page.tsx
 *
 * Encapsulates every lead-level write (mutation) path on the leads dashboard.
 * Pure 1:1 move from page.tsx — no business logic changed. The handlers
 * originally lived inline in LeadsContent; this hook makes them testable
 * and brings the page closer to a render-only shell.
 *
 * Why a separate hook from useLeadsData?
 *   - useLeadsData owns the read side (queries via useSupabaseQuery).
 *   - useLeadMutations owns the write side (mutations stay direct
 *     supabase.from() calls — T1-1 freeze rule applies to *queries*
 *     only; mutations are explicitly out of scope per the dispatch).
 *   - Keeps the page-level orchestrator (page.tsx) focused on UI state
 *     + composition, with one mutation surface to mock in tests.
 *
 * Stage transitions are deliberately absent from this dashboard hook. They
 * require the Lead detail page's controlled API path, which records the
 * required stage note and enforces the current-stage completion gates.
 *
 * T3-3 step 7 — ui interface slim-down
 *   - The original `ui` parameter was a 13-setter bundle used by handlers
 *     to read current editor text + close picker flags on completion.
 *   - After step 7 (LeadCard.tsx), all editor state is owned by LeadCard
 *     itself. The hook no longer needs the full UI bundle: editors are
 *     closed on-click by LeadCard before invoking the mutation handler,
 *     and the 3 text-input editors (note / nextAction / nextFollowup)
 *     have their text passed as a handler argument.
 *   - The hook invokes `onSuccess?.()` after each text-editor write
 *     completes successfully, giving LeadCard the hook to clear its
 *     input + close picker only on a confirmed DB write.
 */

import { useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { toast } from "sonner";
import type { Lead } from "./useLeadsData";

/* ─── Types ─── */
export interface SalesUser {
  id: string;
  email: string | null;
  role: string | null;
  full_name: string | null;
}

export interface UseLeadMutationsParams {
  leads: Lead[];
  setLeads: React.Dispatch<React.SetStateAction<Lead[]>>;
  userId: string | null;
  role: string | null;
  salesUsers: SalesUser[];
  userNameMap: Record<string, string>;
  fetchLeads: () => void;
  setError: (msg: string | null) => void;
  t: (key: string) => string;
  lang: string;
  /**
   * Page-level state setters (used by reassignSales to clear the
   * reassign dropdown on completion). These are page concerns —
   * not editor state — so they stay top-level instead of being
   * lumped into `editors`.
   */
    setReassignLeadId: (v: string | null) => void;
    setReassigning: (v: boolean) => void;
  }

export interface UseLeadMutationsReturn {
  reassignSales: (leadId: string, newUserId: string) => Promise<void>;
  writeEvent: (
    leadId: string,
    eventType: string,
    description: string,
    eventData?: Record<string, any>
  ) => Promise<void>;
  handleDelete: (leadId: string, leadAssignedTo: string | null) => Promise<void>;
  changeProbability: (leadId: string, prob: number) => Promise<void>;
  changeStatus: (leadId: string, status: string) => Promise<void>;
  changeLostReason: (leadId: string, reason: string) => Promise<void>;
  /**
   * Add a quick note to a lead. Text comes from LeadCard (it owns the
   * input state). `onSuccess` is invoked after the activity row + lead
   * timestamp update both succeed — used by LeadCard to clear its own
   * input + close the picker only on a confirmed write.
   */
  addQuickNote: (leadId: string, text: string, onSuccess?: () => void) => Promise<void>;
  updateNextAction: (leadId: string, text: string, onSuccess?: () => void) => Promise<void>;
  updateNextFollowup: (leadId: string, date: string, onSuccess?: () => void) => Promise<void>;
}

/* ─── Hook ─── */
export function useLeadMutations(params: UseLeadMutationsParams): UseLeadMutationsReturn {
  const supabase = createClient();
  const {
    leads,
    setLeads,
    role: salesRole,
    userId: currentUserId,
    salesUsers,
    fetchLeads,
    setError,
    t,
    lang,
    setReassignLeadId,
    setReassigning,
  } = params;

  // ─── Write business event ───
  // P3-12: route via POST /api/leads/[id]/events instead of the direct
  // supabase.from('business_events').insert(...) that lived here before.
  // Mirrors the P3-11 detail-page hook pattern but stays fire-and-forget
  // by design — the list page has no critical UI for missing audit rows,
  // so a console.error is enough and we deliberately do NOT toast.
  // Signature is unchanged: (leadId, eventType, description, eventData?)
  // → Promise<void>, so all remaining dashboard mutation call sites
  // (reassignSales, changeProbability, changeStatus, changeLostReason, addQuickNote,
  // updateNextAction, updateNextFollowup) keep working as-is.
  const writeEvent = useCallback(
    async (leadId: string, eventType: string, description: string, eventData?: Record<string, any>) => {
      if (!currentUserId) return;
      try {
        const res = await fetch(`/api/leads/${leadId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventType, description, eventData: eventData ?? {} }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          console.error("Failed to write business event:", res.status, json?.error || "");
        }
      } catch (e) {
        console.error("Failed to write business event:", e);
      }
    },
    [currentUserId]
  );

  // ─── Sales reassignment ───
  const reassignSales = useCallback(
    async (leadId: string, newUserId: string) => {
      setReassigning(true);
      const oldLead = leads.find(l => l.id === leadId);
      if (!oldLead) return;
      const newUser = salesUsers.find(u => u.id === newUserId);
      if (!newUser) {
        setReassigning(false);
        setError(t("common.saveFailed"));
        return;
      }
      try {
        const response = await fetch(`/api/leads/${leadId}/assignment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignedTo: newUserId,
            expectedUpdatedAt: oldLead.updated_at,
            idempotencyKey: crypto.randomUUID(),
            reason: "manual_reassign",
          }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          setError(payload.error || t("common.saveFailed"));
          return;
        }
        setReassignLeadId(null);
        fetchLeads();
      } finally {
        setReassigning(false);
      }
    },
    [leads, salesUsers, fetchLeads, setError, setReassignLeadId, setReassigning, t]
  );

  // ─── Delete lead ───
  const handleDelete = useCallback(
    async (leadId: string, leadAssignedTo: string | null) => {
      const canDelete = salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && leadAssignedTo === currentUserId);
      if (!canDelete) return;
      const confirmed = confirm(t("leadDetail.confirmDelete") || "Are you sure you want to delete this lead? This action cannot be undone.");
      if (!confirmed) return;
      const { error: delErr } = await supabase.from("leads").delete().eq("id", leadId);
      if (delErr) {
        console.error("Failed to delete lead:", delErr);
        toast.error(t("common.saveFailed") || "Delete failed");
        return;
      }
      toast.success(lang === "zh" ? "已删除" : "Lead deleted");
      fetchLeads();
    },
    [salesRole, currentUserId, fetchLeads, t, lang]
  );

  // ─── Change probability ───
  const changeProbability = useCallback(
    async (leadId: string, prob: number) => {
      const { error: changeProbErr } = await supabase.from("leads").update({ win_probability: prob, updated_at: new Date().toISOString() }).eq("id", leadId);
      if (changeProbErr) {
        console.error("Failed to update probability:", changeProbErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      await writeEvent(leadId, "probability_changed", t("leads.eventWinProb").replace("{prob}", String(prob)), { probability: prob });
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Change lead status ───
  const changeStatus = useCallback(
    async (leadId: string, status: string) => {
      const { error: changeStatusErr } = await supabase.from("leads").update({ lead_status: status, updated_at: new Date().toISOString() }).eq("id", leadId);
      if (changeStatusErr) {
        console.error("Failed to update lead status:", changeStatusErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      await writeEvent(leadId, "status_changed", t("leads.eventStatus").replace("{status}", t(`statusLabels.${status}`)), { status });
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Change lost reason (final_status = "lost" + audit) ───
  const changeLostReason = useCallback(
    async (leadId: string, reason: string) => {
      const { error: lostReasonErr } = await supabase.from("leads").update({
        lost_reason: reason, final_status: "lost", updated_at: new Date().toISOString(),
      }).eq("id", leadId);
      if (lostReasonErr) {
        console.error("Failed to update lost reason:", lostReasonErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      const { error: lostReasonActErr } = await supabase.from("activities").insert({
        lead_id: leadId, type: "stage_change",
        content: t("leads.eventLostReason").replace("{reason}", reason),
        user_id: currentUserId,
      });
      if (lostReasonActErr) console.error("Failed to insert activity:", lostReasonActErr);
      await writeEvent(leadId, "lost_reason_set", t("leads.eventLostReason").replace("{reason}", reason), { lost_reason: reason });
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Add quick note + bump last_contact_date ───
  const addQuickNote = useCallback(
    async (leadId: string, text: string, onSuccess?: () => void) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const { error: quickNoteErr } = await supabase.from("activities").insert({ lead_id: leadId, type: "note", content: trimmed, user_id: currentUserId });
      if (quickNoteErr) {
        console.error("Failed to insert note activity:", quickNoteErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      const { error: quickNoteLeadErr } = await supabase.from("leads").update({ last_contact_date: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", leadId);
      if (quickNoteLeadErr) {
        console.error("Failed to update lead last contact:", quickNoteLeadErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      await writeEvent(leadId, "note_added", t("leads.eventNote").replace("{note}", trimmed));
      onSuccess?.();
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Update next action ───
  const updateNextAction = useCallback(
    async (leadId: string, text: string, onSuccess?: () => void) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const { error: nextActionErr } = await supabase.from("leads").update({ next_action: trimmed, updated_at: new Date().toISOString() }).eq("id", leadId);
      if (nextActionErr) {
        console.error("Failed to update next action:", nextActionErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      await writeEvent(leadId, "followup_scheduled", t("leads.eventNextAction").replace("{action}", trimmed), { next_action: trimmed });
      onSuccess?.();
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Update next followup date (increment followup_count + notify) ───
  const updateNextFollowup = useCallback(
    async (leadId: string, date: string, onSuccess?: () => void) => {
      if (!date) return;
      const oldLead = leads.find(l => l.id === leadId);
      const { error: nextFollowupErr } = await supabase.from("leads").update({
        next_followup_date: date,
        followup_count: (oldLead?.followup_count || 0) + 1,
        updated_at: new Date().toISOString()
      }).eq("id", leadId);
      if (nextFollowupErr) {
        console.error("Failed to update next followup:", nextFollowupErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      // Create activity record
      const { error: actErr } = await supabase.from("activities").insert({
        lead_id: leadId, type: "followup_scheduled",
        content: `Follow-up scheduled for ${date}`,
        user_id: currentUserId,
      });
      if (actErr) console.error("Failed to insert activity:", actErr);
      await writeEvent(leadId, "followup_scheduled", t("leads.eventFollowup").replace("{date}", date), { next_followup_date: date });
      // Notify the assigned salesperson
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "followup_reminder", lead_id: leadId, assigned_to: oldLead?.assigned_to, due_date: date });
      });
      onSuccess?.();
      fetchLeads();
    },
    [leads, writeEvent, fetchLeads, setError, t]
  );

  return {
    reassignSales,
    writeEvent,
    handleDelete,
    changeProbability,
    changeStatus,
    changeLostReason,
    addQuickNote,
    updateNextAction,
    updateNextFollowup,
  };
}
