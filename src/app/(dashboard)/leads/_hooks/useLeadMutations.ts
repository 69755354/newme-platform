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
 *     business_events (analytics). The business_events insert is no longer
 *     direct — see P3-11/P3-12: changeStage's lead/quotation/activity inserts
 *     stay direct, but the audit row is written via POST /api/leads/[id]/events.
 *   - Backwards / skip-stage guards are admin/boss-aware.
 *   - DO NOT edit the block body when refactoring — it's covered by
 *     CRM v3.1 P1P1 plan risk register at line 5191.
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
import { PIPELINE_STAGES } from "../_utils/constants";

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
  changeStage: (leadId: string, newStage: string) => Promise<void>;
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
  // → Promise<void>, so all 7 call sites (reassignSales, changeStage,
  // changeProbability, changeStatus, changeLostReason, addQuickNote,
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
      const oldUser = salesUsers.find(u => u.id === oldLead.assigned_to);
      const newUserName = newUser?.full_name || newUser?.email || newUserId;
      const oldName = oldUser?.full_name || oldUser?.email || "Unknown";

      await writeEvent(leadId, "transfer", `Reassigned from ${oldName} to ${newUserName}`);

      await supabase.from("leads").update({ assigned_to: newUserId, updated_at: new Date().toISOString() }).eq("id", leadId);

      await supabase.from("transfer_history").insert({
        lead_id: leadId, from_user_id: oldLead.assigned_to, to_user_id: newUserId,
        reason: "manual_reassign", transferred_by: currentUserId,
      });

      await supabase.from("activities").insert({
        lead_id: leadId, type: "transfer", content: `Reassigned from ${oldName} to ${newUserName}`,
        user_id: currentUserId,
      });

      // Notify the newly assigned salesperson
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "lead_assigned", lead_id: leadId, assigned_to: newUserId });
      });

      setReassignLeadId(null);
      setReassigning(false);
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

      // Guard 6: first_contact gate — new → contacted requires 3 contacts + quality filled
      if (oldLead.stage === "new" && newStage === "contacted" && !canRevert) {
        const { count: contactCount } = await supabase
          .from("follow_up_logs")
          .select("*", { count: "exact", head: true })
          .eq("lead_id", leadId);
        if ((contactCount ?? 0) < 3) {
          setError(lang === "zh" 
            ? `需要 3 次联系记录（当前 ${contactCount ?? 0}/3）` 
            : `Need 3 contact records (current ${contactCount ?? 0}/3)`);
          return;
        }
        if (!oldLead.quality || oldLead.quality === "pending") {
          setError(lang === "zh" 
            ? "请先完成质量判断（Poor/Normal/Good）" 
            : "Please complete quality assessment first (Poor/Normal/Good)");
          return;
        }
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
        user_id: currentUserId,
      });
      if (changeStageActErr) console.error("Failed to insert activity:", changeStageActErr);
      await writeEvent(leadId, "stage_change", t("leads.eventStageChanged").replace("{from}", t(`stageLabels.${oldLead?.stage || "?"}`)).replace("{to}", t(`stageLabels.${newStage}`)), {
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
    changeStage,
    changeProbability,
    changeStatus,
    changeLostReason,
    addQuickNote,
    updateNextAction,
    updateNextFollowup,
  };
}
