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
 * Notable risk: changeStage (the largest handler at ~94 lines)
 *   - Optimistic lock via count:"exact" + eq("updated_at", oldLead.updated_at).
 *     Stale writes short-circuit with a user-visible error and refetch.
 *   - 4-table cascade: leads (with STAGE_AUTO auto-fields), quotations
 *     (terminal stage closes open quotes), activities (audit), and
 *     business_events (analytics). All four inserts are preserved verbatim.
 *   - Backwards / skip-stage guards are admin/boss-aware.
 *   - DO NOT edit the block body when refactoring — it's covered by
 *     CRM v3.1 P1P1 plan risk register at line 5191.
 *
 * Local UI state (noteText, nextActionText, editing* flags, etc.) is owned
 * by the page and passed in as the `ui` object so the hook can both
 * *read* (current text to persist) and *clear* (reset on success) without
 * the hook owning layout state.
 */

import { useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { toast } from "sonner";
import type { Lead } from "./useLeadsData";
import { PIPELINE_STAGES } from "../_utils/constants";

/* ─── Types ─── */
export interface SalesUser {
  id: string;
  email: string | null;
  role: string | null;
  full_name: string | null;
}

export interface LeadMutationsUI {
  noteText: string;
  setNoteText: (v: string) => void;
  setNoteLeadId: (v: string | null) => void;
  nextActionText: string;
  setNextActionText: (v: string) => void;
  nextFollowupText: string;
  setNextFollowupText: (v: string) => void;
  setEditingStage: (v: string | null) => void;
  setEditingProbability: (v: string | null) => void;
  setEditingStatus: (v: string | null) => void;
  setEditingLostReason: (v: string | null) => void;
  setEditingNextAction: (v: string | null) => void;
  setEditingNextFollowup: (v: string | null) => void;
  setReassignLeadId: (v: string | null) => void;
  setReassigning: (v: boolean) => void;
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
  ui: LeadMutationsUI;
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
  changeStage: (leadId: string, newStage: string) => Promise<void>;
  changeProbability: (leadId: string, prob: number) => Promise<void>;
  changeStatus: (leadId: string, status: string) => Promise<void>;
  changeLostReason: (leadId: string, reason: string) => Promise<void>;
  addQuickNote: (leadId: string) => Promise<void>;
  updateNextAction: (leadId: string) => Promise<void>;
  updateNextFollowup: (leadId: string) => Promise<void>;
}

/* ─── Stage auto-properties (preserved verbatim) ─── */
const STAGE_AUTO: Record<string, { win_probability: number; lead_status?: string; next_action?: string }> = {
  new: { win_probability: 10, next_action: "Contact lead" },
  contacted: { win_probability: 10, next_action: "Confirm requirements" },
  requirement_confirmed: { win_probability: 30, next_action: "Prepare solution" },
  solution_submitted: { win_probability: 30, next_action: "Prepare quotation" },
  quotation_submitted: { win_probability: 50, next_action: "Follow up on quotation" },
  negotiation: { win_probability: 70, next_action: "Negotiate terms" },
  pending_decision: { win_probability: 90, next_action: "Close deal" },
  won: { win_probability: 100, lead_status: "hot", next_action: "Send contract" },
  lost: { win_probability: 0, lead_status: "dormant", next_action: undefined },
};
const STAGE_INDEX: Record<string, number> = {};
PIPELINE_STAGES.forEach((s, i) => { STAGE_INDEX[s.key] = i; });
const TERMINAL_STAGES = new Set(["won", "lost"]);

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
    ui,
  } = params;

  // ─── Write business event ───
  const writeEvent = useCallback(
    async (leadId: string, eventType: string, description: string, eventData?: Record<string, any>) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { error: writeEventErr } = await supabase.from("business_events").insert({
        lead_id: leadId,
        event_type: eventType,
        description: description,
        event_data: eventData || {},
        user_id: userId,
      });
      if (writeEventErr) console.error("Failed to write business event:", writeEventErr);
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Sales reassignment ───
  const reassignSales = useCallback(
    async (leadId: string, newUserId: string) => {
      ui.setReassigning(true);
      const oldLead = leads.find(l => l.id === leadId);
      if (!oldLead) return;
      const newUser = salesUsers.find(u => u.id === newUserId);
      const oldUser = salesUsers.find(u => u.id === oldLead.assigned_to);
      const newUserName = newUser?.full_name || newUser?.email || newUserId;
      const oldName = oldUser?.full_name || oldUser?.email || "Unknown";

      await supabase.from("leads").update({ assigned_to: newUserId, updated_at: new Date().toISOString() }).eq("id", leadId);

      await supabase.from("transfer_history").insert({
        lead_id: leadId, from_user_id: oldLead.assigned_to, to_user_id: newUserId,
        reason: "manual_reassign", transferred_by: (await supabase.auth.getUser()).data.user?.id,
      });

      await supabase.from("activities").insert({
        lead_id: leadId, type: "transfer", content: `Reassigned from ${oldName} to ${newUserName}`,
        user_id: (await supabase.auth.getUser()).data.user?.id,
      });

      await writeEvent(leadId, "transfer", `Reassigned from ${oldName} to ${newUserName}`);

      // Notify the newly assigned salesperson
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "lead_assigned", lead_id: leadId, assigned_to: newUserId });
      });

      ui.setReassignLeadId(null);
      ui.setReassigning(false);
      fetchLeads();
    },
    [leads, salesUsers, writeEvent, fetchLeads] // eslint-disable-line react-hooks/exhaustive-deps
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

  // ─── Change stage (the big one) ───
  const changeStage = useCallback(
    async (leadId: string, newStage: string) => {
      ui.setEditingStage(null);
      const oldLead = leads.find(l => l.id === leadId);
      if (!oldLead) return;

      // Guard 1: no-op
      if (oldLead.stage === newStage) return;

      // Guard 2: valid stage
      if (!(newStage in STAGE_INDEX)) {
        setError(t("common.invalidStage") + `: "${newStage}"`);
        return;
      }

      // Guard 3: can't move from terminal (won/lost now live in final_status, not stage)
      if (oldLead.final_status) {
        setError(t("common.cannotChangeClosedLead"));
        return;
      }

      // Guard 4: enforce forward-only for non-admin (admin/boss can revert)
      const oldIdx = STAGE_INDEX[oldLead.stage];
      const newIdx = STAGE_INDEX[newStage];
      const canRevert = salesRole === "admin" || salesRole === "boss";
      if (!canRevert && newIdx < oldIdx) {
        setError(t("common.cannotMoveBackward"));
        return;
      }

      // Guard 5: max 1 step forward for sales (admin/boss can skip)
      if (!canRevert && newIdx - oldIdx > 1) {
        setError(t("common.cannotSkipStages"));
        return;
      }

      // Build updates
      const now = new Date().toISOString();
      const auto = STAGE_AUTO[newStage];
      // won/lost are terminal → persist to final_status, not stage
      const updates: Record<string, any> = { updated_at: now, last_contact_date: now };
      if (newStage === "won" || newStage === "lost") {
        updates.final_status = newStage;
      } else {
        updates.stage = newStage;
      }
      if (auto) {
        updates.win_probability = auto.win_probability;
        if (auto.lead_status) updates.lead_status = auto.lead_status;
        if (auto.next_action) updates.next_action = auto.next_action;
      }
      if (TERMINAL_STAGES.has(newStage)) {
        updates.decision_date = now;

        // Cascade: close related open quotes
        await supabase.from("quotations")
          .update({ status: newStage === "lost" ? "draft" : undefined, updated_at: now })
          .eq("lead_id", leadId)
          .neq("status", "accepted");
      }

      // Optimistic lock: only write if the row hasn't changed since we read it into
      // React state. Prevents two reps clobbering each other's stage transition.
      // count:"exact" lets us detect a stale-write (0 rows matched = someone else moved it).
      const { error: changeStageErr, count } = await supabase
        .from("leads")
        .update(updates, { count: "exact" })
        .eq("id", leadId)
        .eq("updated_at", oldLead.updated_at);
      if (changeStageErr) {
        console.error("Failed to update lead stage:", changeStageErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      if (count === 0) {
        // Stale write: the lead was modified by another user between read and write.
        setError(t("common.staleWrite") || "This lead was just updated by someone else. Refreshing…");
        fetchLeads();
        return;
      }
      const { error: changeStageActErr } = await supabase.from("activities").insert({
        lead_id: leadId, type: "stage_change",
        content: t("leads.eventStageChange").replace("{stage}", t(`stageLabels.${newStage}`)),
        user_id: (await supabase.auth.getUser()).data.user?.id,
      });
      if (changeStageActErr) console.error("Failed to insert activity:", changeStageActErr);
      await writeEvent(leadId, "stage_changed", t("leads.eventStageChanged").replace("{from}", t(`stageLabels.${oldLead?.stage || "?"}`)).replace("{to}", t(`stageLabels.${newStage}`)), {
        from: oldLead?.stage, to: newStage, auto_updates: Object.keys(updates).filter(k => k !== "stage" && k !== "updated_at"),
      });
      // Notify admins about important stage changes
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "lead_stage_change", lead_id: leadId, from_stage: oldLead?.stage, to_stage: newStage });
      });
      fetchLeads();
    },
    [leads, salesRole, writeEvent, fetchLeads, setError, t] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Change probability ───
  const changeProbability = useCallback(
    async (leadId: string, prob: number) => {
      ui.setEditingProbability(null);
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
      ui.setEditingStatus(null);
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
      ui.setEditingLostReason(null);
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
        user_id: (await supabase.auth.getUser()).data.user?.id,
      });
      if (lostReasonActErr) console.error("Failed to insert activity:", lostReasonActErr);
      await writeEvent(leadId, "lost_reason_set", t("leads.eventLostReason").replace("{reason}", reason), { lost_reason: reason });
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Add quick note + bump last_contact_date ───
  const addQuickNote = useCallback(
    async (leadId: string) => {
      if (!ui.noteText.trim()) return;
      const { error: quickNoteErr } = await supabase.from("activities").insert({ lead_id: leadId, type: "note", content: ui.noteText.trim(), user_id: (await supabase.auth.getUser()).data.user?.id });
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
      await writeEvent(leadId, "note_added", t("leads.eventNote").replace("{note}", ui.noteText.trim()));
      ui.setNoteText(""); ui.setNoteLeadId(null);
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Update next action ───
  const updateNextAction = useCallback(
    async (leadId: string) => {
      if (!ui.nextActionText.trim()) return;
      ui.setEditingNextAction(null);
      const { error: nextActionErr } = await supabase.from("leads").update({ next_action: ui.nextActionText.trim(), updated_at: new Date().toISOString() }).eq("id", leadId);
      if (nextActionErr) {
        console.error("Failed to update next action:", nextActionErr);
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
      await writeEvent(leadId, "followup_scheduled", t("leads.eventNextAction").replace("{action}", ui.nextActionText.trim()), { next_action: ui.nextActionText.trim() });
      ui.setNextActionText("");
      fetchLeads();
    },
    [writeEvent, fetchLeads, setError, t]
  );

  // ─── Update next followup date (increment followup_count + notify) ───
  const updateNextFollowup = useCallback(
    async (leadId: string) => {
      if (!ui.nextFollowupText) return;
      ui.setEditingNextFollowup(null);
      const oldLead = leads.find(l => l.id === leadId);
      const { error: nextFollowupErr } = await supabase.from("leads").update({
        next_followup_date: ui.nextFollowupText,
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
        content: `Follow-up scheduled for ${ui.nextFollowupText}`,
        user_id: (await supabase.auth.getUser()).data.user?.id,
      });
      if (actErr) console.error("Failed to insert activity:", actErr);
      await writeEvent(leadId, "followup_scheduled", t("leads.eventFollowup").replace("{date}", ui.nextFollowupText), { next_followup_date: ui.nextFollowupText });
      // Notify the assigned salesperson
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "followup_reminder", lead_id: leadId, assigned_to: oldLead?.assigned_to, due_date: ui.nextFollowupText });
      });
      ui.setNextFollowupText("");
      fetchLeads();
    },
    [leads, writeEvent, fetchLeads, setError, t]
  );

  return {
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
  };
}