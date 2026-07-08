"use client";

/**
 * useLeadDetailMutations — T3-3 step 11 extracted from leads/[id]/page.tsx
 *
 * Encapsulates every mutation (write) handler for the Lead Detail three-column
 * layout: reassignSales, handleDelete, handleMarkPoor, writeEvent, updateField,
 * saveProjectInfo, resetProjectInfoDraft, updateStage, updateNextTask,
 * handleWon, handleLost, addNote, toggleMilestone — 12 handler-shaped entry
 * points plus the shared updateNextTask (Next Required Action editor).
 *
 * Why a separate hook from useLeadDetailData?
 *   - useLeadDetailData owns the read side (queries → state).
 *   - useLeadDetailMutations owns the write side (mutations stay direct
 *     supabase.from() calls — same pattern as leads/_hooks/useLeadMutations).
 *   - Keeps page.tsx closer to a render-only shell.
 *
 * Page-level UI state (openPanel, showQuoteCalculator, noteText) and render
 * helpers (openQuoteCalculator, handleCreateContract, handleGenerateKnx) stay
 * on page.tsx — they're presentation concerns, not mutations.
 *
 * Pure 1:1 move from page.tsx — no business logic changed. The handlers'
 * original logging, toast text, and error paths are preserved verbatim.
 */

import { useCallback, useState } from "react";
import { createClient } from "@/lib/supabase";
import { toast } from "sonner";
import { MILESTONE_LABELS, MILESTONE_DESCRIPTIONS } from "@/lib/milestones";
import { createFollowUpTask } from "@/lib/tasks";
import { projectDraftFromLead } from "./utils";
import type { Lead, Task } from "./types";
import type { ProjectInfoDraft } from "./useLeadDetailData";

/* ─── Types ─── */
export interface SalesUserMini {
  id: string;
  email: string | null;
  role: string | null;
  full_name: string | null;
}

export interface UseLeadDetailMutationsParams {
  leadId: string;
  lead: Lead | null;
  nextTask: Task | null;
  /** Setter from useLeadDetailData — needed by reassignSales + updateField. */
  setLead: React.Dispatch<React.SetStateAction<Lead | null>>;
  /** projectInfoDraft state lives on useLeadDetailData (seeded by fetchData). */
  projectInfoDraft: ProjectInfoDraft;
  setProjectInfoDraft: React.Dispatch<React.SetStateAction<ProjectInfoDraft>>;
  /** The original fetchData ref — re-fetch after every successful mutation. */
  fetchData: () => Promise<void>;
  /** salesRole + currentUserId are needed by handleDelete guard. */
  salesRole: string | null;
  currentUserId: string | null;
  /** sales users list — needed by reassignSales for oldName/newUserName lookup. */
  salesUsers: SalesUserMini[];
  /** i18n context — both t() and lang() are used by toasts. */
  t: (key: string) => string;
  lang: string;
}

export interface UseLeadDetailMutationsReturn {
  // Page-render state
  updating: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error";
  editField: string | null;
  editValue: string;
  showSalesDropdown: boolean;
  reassigning: boolean;
  markingPoor: boolean;
  poorReasonText: string;
  projectInfoStatus: "idle" | "saving" | "saved" | "error";
  // Setters
  setUpdating: React.Dispatch<React.SetStateAction<boolean>>;
  setEditField: React.Dispatch<React.SetStateAction<string | null>>;
  setEditValue: React.Dispatch<React.SetStateAction<string>>;
  setShowSalesDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  setMarkingPoor: React.Dispatch<React.SetStateAction<boolean>>;
  setPoorReasonText: React.Dispatch<React.SetStateAction<string>>;
  setProjectInfoStatus: React.Dispatch<React.SetStateAction<"idle" | "saving" | "saved" | "error">>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  // Handlers
  reassignSales: (newUserId: string) => Promise<void>;
  handleDelete: () => Promise<void>;
  handleMarkPoor: () => Promise<void>;
  writeEvent: (eventType: string, description: string, eventData?: Record<string, any>) => Promise<void>;
  updateField: (field: string, value: any, eventType?: string, eventDesc?: string) => Promise<boolean>;
  saveProjectInfo: () => Promise<void>;
  resetProjectInfoDraft: () => void;
  updateStage: (stage: string) => Promise<boolean>;
  updateNextTask: (updates: Partial<Pick<Task, "title" | "due_at">>) => Promise<void>;
  handleWon: () => Promise<void>;
  handleLost: () => Promise<void>;
  addNote: (noteText: string) => Promise<void>;
  toggleMilestone: (milestoneKey: string, currentlyCompleted: boolean) => Promise<void>;
}

/* ─── Hook ─── */
export function useLeadDetailMutations(params: UseLeadDetailMutationsParams): UseLeadDetailMutationsReturn {
  const supabase = createClient();
  const {
    leadId,
    lead,
    nextTask,
    setLead,
    projectInfoDraft,
    fetchData,
    salesRole,
    currentUserId,
    salesUsers,
    t,
    lang,
  } = params;

  // ─── UI state (12 mutation-driven state vars mirror page.tsx originals) ─
  const [updating, setUpdating] = useState(false);
  // Inline field-save status (Saving / Saved / Error) shown for any updateField call.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [showSalesDropdown, setShowSalesDropdown] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [markingPoor, setMarkingPoor] = useState(false);
  const [poorReasonText, setPoorReasonText] = useState("");
  // Project Info batch-save form (bottom folding panel) — local draft + status.
  const [projectInfoStatus, setProjectInfoStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Hook-local error (setError) — accept both null and SetStateAction for
  // interop with the page-level setError returned by useLeadDetailData.
  const [_error, _setError] = useState<string | null>(null);
  const setError = _setError as React.Dispatch<React.SetStateAction<string | null>>;

  // ─── Sales reassignment ───
  // P3-11: the inline business_events insert at the end of this function
  // previously went through supabase.from('business_events').insert(...)
  // directly. Route via POST /api/leads/[id]/events instead so the canonical
  // column shape lives in one place and the CHECK constraint can never be
  // bypassed from a stale client bundle.
  const reassignSales = useCallback(
    async (newUserId: string) => {
      setReassigning(true);
      try {
        const oldLead = lead!;
        const newUser = salesUsers.find((u) => u.id === newUserId);
        const oldUser = salesUsers.find((u) => u.id === oldLead.assigned_to);
        const newUserName = newUser?.full_name || newUser?.email || newUserId;
        const oldName = oldUser?.full_name || oldUser?.email || oldLead.rep_name || "Unknown";
        const transferDesc = `Reassigned from ${oldName} to ${newUserName}`;
        // Log while the current salesperson still owns the lead so the route's
        // ownership check does not race the assigned_to update below.
        try {
          const res = await fetch(`/api/leads/${leadId}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ eventType: "transfer", description: transferDesc }),
          });
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            const msg =
              (json as any)?.error ||
              (res.status === 401
                ? t("common.unauthorized") || "Unauthorized"
                : res.status === 403
                  ? t("common.forbidden") || "Forbidden"
                  : t("common.saveFailed") || "Failed to log transfer event");
            toast.error(msg);
          }
        } catch (e) {
          console.warn("[LeadDetail] business_events transfer log failed", e);
          toast.error(t("common.saveFailed") || "Failed to log transfer event");
        }
        // Apply ownership change only after the best-effort audit attempt.
        const { error: updateErr } = await supabase.from("leads").update({ assigned_to: newUserId, updated_at: new Date().toISOString() }).eq("id", leadId);
        if (updateErr) {
          console.error("[LeadDetail] reassign failed");
          toast.error(t("common.saveFailed"));
          return;
        }
        const { data: { user: currentUser } } = await supabase.auth.getUser();
        await supabase.from("transfer_history").insert({ lead_id: leadId, from_user_id: oldLead.assigned_to, to_user_id: newUserId, reason: "manual_reassign", transferred_by: currentUser?.id });
        await supabase.from("activities").insert({ lead_id: leadId, type: "transfer", content: transferDesc, user_id: currentUser?.id });
        import("@/lib/notify").then(({ notify }) => {
          notify({ type: "lead_assigned", lead_id: leadId, assigned_to: newUserId });
        });
        setLead({ ...oldLead, assigned_to: newUserId, rep_name: newUserName });
        setShowSalesDropdown(false);
      } finally {
        setReassigning(false);
      }
    },
    [leadId, lead, salesUsers, setLead, t] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Delete lead ───
  const handleDelete = useCallback(async () => {
    if (!lead) return;
    const canDelete = salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && lead.assigned_to === currentUserId);
    if (!canDelete) return;
    const confirmed = confirm(t("leadDetail.confirmDelete") || "Are you sure you want to delete this lead? This action cannot be undone.");
    if (!confirmed) return;
    const { error: delErr } = await supabase.from("leads").delete().eq("id", lead.id);
    if (delErr) {
      console.error("[LeadDetail] delete failed");
      toast.error(t("common.saveFailed") || "Delete failed");
      return;
    }
    toast.success(lang === "zh" ? "已删除" : "Lead deleted");
    window.location.href = "/leads";
  }, [lead, salesRole, currentUserId, t, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Mark lead as poor quality ───
  // P0 schema-alias fix: route via /api/leads/[id]/quality instead of direct
  // supabase.from('leads').update(). The API owns the leads.quality write AND
  // the business_events audit insert (avoids the client-side column-mismatch
  // trap where business_events column aliases differ between client and PROD
  // DDL — the API writes the canonical shape; the client never sees the
  // mismatch). For 'poor' ratings, a non-empty poor_reason is required
  // (the API 400s otherwise); 'normal' and 'good' may be sent without it.
  const postQuality = useCallback(
    async (quality: "poor" | "normal" | "good", poor_reason: string | null) => {
      const body: Record<string, unknown> = { quality };
      if (quality === "poor") body.poor_reason = poor_reason ?? "";
      const res = await fetch(`/api/leads/${leadId}/quality`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (json as any)?.error ||
          (res.status === 401
            ? t("common.unauthorized") || "Unauthorized"
            : res.status === 403
              ? t("common.forbidden") || "Forbidden"
              : t("common.saveFailed") || "Failed to update quality");
        toast.error(msg);
        return false;
      }
      // Surface the API-reported audit status in non-prod only.
      if (process.env.NODE_ENV !== "production" && (json as any)?.eventError) {
        console.warn("quality event log failed:", (json as any).eventError);
      }
      return true;
    },
    [leadId, t]
  );

  const handleMarkPoor = useCallback(async () => {
    if (!poorReasonText.trim() || !lead) return;
    const ok = await postQuality("poor", poorReasonText.trim());
    if (!ok) return;
    setMarkingPoor(false);
    setPoorReasonText("");
    // Router refresh happens on the page side; we trigger fetchData instead.
    await fetchData();
  }, [poorReasonText, lead, postQuality, fetchData]);

  // ─── Write a business_events row ───
  // P3-11: route via POST /api/leads/[id]/events instead of the direct
  // supabase.from('business_events').insert(...) that lived here before.
  // Signature is unchanged so every call site (updateField, saveProjectInfo)
  // continues to work. On API failure, surface the same toast pattern that
  // postQuality uses — no silent drops.
  const writeEvent = useCallback(async (eventType: string, description: string, eventData?: Record<string, any>) => {
    const res = await fetch(`/api/leads/${leadId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType, description, eventData: eventData ?? {} }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg =
        (json as any)?.error ||
        (res.status === 401
          ? t("common.unauthorized") || "Unauthorized"
          : res.status === 403
            ? t("common.forbidden") || "Forbidden"
            : res.status === 400
              ? (json as any)?.error || t("common.saveFailed") || "Invalid event"
              : t("common.saveFailed") || "Failed to write event");
      toast.error(msg);
      console.warn("[LeadDetail] business_events writeEvent failed", res.status, msg);
    }
  }, [leadId, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Update a single editable field with optimistic saveStatus + audit ───
  const updateField = useCallback(async (field: string, value: any, eventType?: string, eventDesc?: string): Promise<boolean> => {
    setUpdating(true);
    setSaveStatus("saving");
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    updates[field] = value;
    const { data: updated, error: err } = await supabase
      .from("leads")
      .update(updates)
      .eq("id", leadId)
      .select("id")
      .single();
    // Fix B: RLS can reject with HTTP 200 + error=null but 0 rows updated.
    // Require the row back so a blocked update never shows a false "Saved".
    if (err || !updated) {
      console.error("[LeadDetail] field update failed");
      setError(t("common.saveFailed") || "Save failed");
      setSaveStatus("error");
      setUpdating(false);
      toast.error(t("common.saveFailed"));
      return false;
    }
    setSaveStatus("saved");
    toast.success(lang === "zh" ? "已保存" : "Saved");
    if (eventType && eventDesc) {
      await supabase.from("activities").insert({ lead_id: leadId, type: eventType, content: eventDesc, user_id: (await supabase.auth.getUser()).data.user?.id });
      await writeEvent(eventType, eventDesc, { [field]: value });
    }
    setEditField(null);
    await fetchData();
    setUpdating(false);
    setTimeout(() => setSaveStatus("idle"), 2500);
    return true;
  }, [leadId, t, lang, writeEvent, fetchData, setError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Project Info batch-save (bottom folding panel) ───
  const saveProjectInfo = useCallback(async () => {
    setProjectInfoStatus("saving");
    const updates: Record<string, any> = {
      project_type: projectInfoDraft.project_type || null,
      emirate: projectInfoDraft.emirate.trim() || null,
      area: projectInfoDraft.area.trim() || null,
      ac_brand: projectInfoDraft.ac_brand.trim() || null,
      customer_budget: projectInfoDraft.customer_budget ? Number(projectInfoDraft.customer_budget) : null,
      updated_at: new Date().toISOString(),
    };
    // Fix B: require the row back so an RLS rejection (HTTP 200, error=null,
    // 0 rows updated) surfaces as a failure instead of a false "Saved".
    const { data: updated, error: err } = await supabase
      .from("leads")
      .update(updates)
      .eq("id", leadId)
      .select("id")
      .single();
    if (err || !updated) {
      console.error("[LeadDetail] project info save failed");
      setProjectInfoStatus("error");
      toast.error(t("common.saveFailed"));
      return;
    }
    // Fix D: write audit (activities + business_event), mirroring updateField().
    // Only fields that actually changed are listed, so the timeline stays useful.
    const before = projectDraftFromLead(lead);
    const changed = (["project_type", "emirate", "area", "ac_brand", "customer_budget"] as const).filter(
      (k) => String(projectInfoDraft[k] ?? "") !== String(before[k] ?? "")
    );
    if (changed.length > 0) {
      const { data: { user } } = await supabase.auth.getUser();
      const prefix = lang === "zh" ? "项目信息已更新" : "Project info updated";
      const desc = `${prefix}: ${changed.join(", ")}`;
      await supabase.from("activities").insert({
        lead_id: leadId, type: "note_added", content: desc, user_id: user?.id ?? null,
      });
      await writeEvent("project_info_updated", desc, Object.fromEntries(changed.map((k) => [k, updates[k]])));
    }
    setProjectInfoStatus("saved");
    toast.success(lang === "zh" ? "项目信息已保存" : "Project info saved");
    await fetchData();
    setTimeout(() => setProjectInfoStatus("idle"), 2500);
  }, [leadId, lead, projectInfoDraft, t, lang, writeEvent, fetchData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Undo local Project Info edits — restore the draft to the last persisted
  // lead values (the same values the form was seeded with on fetch).
  const resetProjectInfoDraft = useCallback(() => {
    params.setProjectInfoDraft(projectDraftFromLead(lead));
    setProjectInfoStatus("idle");
  }, [lead, params]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Stage update (final_status for won/lost, stage otherwise) ───
  const updateStage = useCallback(async (stage: string): Promise<boolean> => {
    // For terminal stages (won/lost), write to BOTH stage (trigger enforces sequence,
    // detail page reads it) AND final_status (list page counts it, trg_lead_won fires on it).
    if (stage === "won" || stage === "lost") {
      const ok = await updateField("stage", stage, "stage_change", `${t("leadDetail.eventTypes.stage_changed")} → ${t(`stageLabels.${stage}`)}`);
      if (!ok) return false;
      // Silently sync final_status after stage update passes trigger
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      const { error: fsErr } = await supabase.from("leads").update({ 
        final_status: stage,
        updated_at: new Date().toISOString() 
      }).eq("id", leadId);
      if (fsErr) console.warn("[LeadDetail] final_status sync failed (non-fatal)", fsErr);
      return true;
    }
    return updateField("stage", stage, "stage_change", `${t("leadDetail.eventTypes.stage_changed")} → ${t(`stageLabels.${stage}`)}`);
  }, [leadId, updateField, t]);

  // ─── Next Required Action — updates nextTask (creates a task if none) ───
  const updateNextTask = useCallback(async (updates: Partial<Pick<Task, "title" | "due_at">>) => {
    if (nextTask) {
      const { error: err } = await supabase.from("tasks").update(updates).eq("id", nextTask.id);
      if (err) {
        console.error("[LeadDetail] task update failed");
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
    } else {
      // P0-7: 还没有 task 时，设置 follow-up 必须创建一条 task 记录（之前会静默 no-op）。
      const { error: err } = await createFollowUpTask(supabase, {
        leadId: leadId,
        dueAt: updates.due_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        title: updates.title,
        assigneeId: lead?.assigned_to ?? null,
        source: "manual",
      });
      if (err) {
        console.error("[LeadDetail] task create failed");
        setError(t("common.saveFailed") || "Save failed");
        return;
      }
    }
    setEditField(null);
    await fetchData();
  }, [nextTask, leadId, lead, t, writeEvent, fetchData, setError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Won / Lost handlers (Stage update + toast, contract via DB trigger) ─
  const handleWon = useCallback(async () => {
    setUpdating(true);
    try {
      // Stage update only — contract & installment creation is handled
      // by the DB trigger trg_lead_won to avoid duplicates
      const updated = await updateStage("won");
      if (!updated) return;
      toast.success(t("leads.markedWon"));
    } catch (e: any) {
      console.error("[LeadDetail] handleWon error");
      toast.error(t("common.operationFailed"));
    } finally {
      setUpdating(false);
    }
  }, [updateStage, t]);

  const handleLost = useCallback(async () => {
    setUpdating(true);
    try {
      const updated = await updateStage("lost");
      if (!updated) return;
      toast.success(t("leads.markedLost"));
    } catch (e: any) {
      console.error("[LeadDetail] handleLost error");
      toast.error(t("common.operationFailed"));
    } finally {
      setUpdating(false);
    }
  }, [updateStage, t]);

  // ─── Add a follow-up log note (immutable source of truth) ───
  // P0-1: notes are written to follow_up_logs (contact_type='note', summary=content,
  // user_id=author). The immutable follow-up log is the source of truth shown in the
  // timeline. Errors surface via toast so a failed insert never silently drops a note.
  //
  // Note: original page.tsx addNote closed over the page-level `noteText` state.
  //       The hook preserves that behavior by accepting noteText as a callback
  //       param — LeadTimeline calls onAddNote() which delegates to this fn
  //       (page wraps the hook's noteText closure into a () => void adapter).
  const addNote = useCallback(async (noteTextParam: string) => {
    if (updating) return;
    const text = noteTextParam.trim();
    if (!text) return;
    setUpdating(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from("follow_up_logs").insert({
      lead_id: leadId,
      user_id: user?.id ?? null,
      contact_type: "note",
      summary: text,
      contact_time: new Date().toISOString(),
      no_answer: false,
    });
    if (insertError) {
      console.error("[LeadDetail] note save failed");
      setUpdating(false);
      toast.error(t("common.saveFailed"));
      return;
    }
    await supabase.from("leads").update({ last_contact_date: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", leadId);
    setUpdating(false);
    toast.success(lang === "zh" ? "备注已保存" : "Note saved");
    await fetchData();
  }, [updating, leadId, t, lang, fetchData]);

  // ─── Milestone toggle: complete the next pending milestone, or uncomplete a completed one ─
  const toggleMilestone = useCallback(async (milestoneKey: string, currentlyCompleted: boolean) => {
    setUpdating(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (currentlyCompleted) {
      // Uncomplete: delete the milestone row
      const { error: delErr } = await supabase
        .from("lead_milestones")
        .delete()
        .eq("lead_id", leadId)
        .eq("milestone_key", milestoneKey);
      if (delErr) {
        console.error("[LeadDetail] milestone uncomplete failed");
        toast.error(t("common.saveFailed"));
        setUpdating(false);
        return;
      }
      toast.success(lang === "zh" ? "里程碑已撤销" : "Milestone undone");
    } else {
      // Complete: insert a new milestone row
      const { error: insErr } = await supabase
        .from("lead_milestones")
        .insert({
          lead_id: leadId,
          milestone_key: milestoneKey,
          completed_by: user?.id ?? null,
          notes: lang === "zh"
            ? `手动完成里程碑: ${MILESTONE_LABELS[milestoneKey] || milestoneKey} — ${MILESTONE_DESCRIPTIONS[milestoneKey]?.zh || ''}`
            : `Manually completed milestone: ${MILESTONE_LABELS[milestoneKey] || milestoneKey} — ${MILESTONE_DESCRIPTIONS[milestoneKey]?.en || ''}`,
        });
      if (insErr) {
        console.error("[LeadDetail] milestone complete failed");
        toast.error(t("common.saveFailed"));
        setUpdating(false);
        return;
      }
      toast.success(lang === "zh" ? "里程碑已完成" : "Milestone completed");
    }
    setUpdating(false);
    await fetchData();
  }, [leadId, t, lang, fetchData]);

  return {
    // Page-render state
    updating, saveStatus, editField, editValue, showSalesDropdown, reassigning, markingPoor, poorReasonText, projectInfoStatus,
    // Setters
    setUpdating, setEditField, setEditValue, setShowSalesDropdown, setMarkingPoor, setPoorReasonText, setProjectInfoStatus, setError,
    // Handlers
    reassignSales, handleDelete, handleMarkPoor, writeEvent, updateField, saveProjectInfo, resetProjectInfoDraft, updateStage, updateNextTask, handleWon, handleLost, addNote, toggleMilestone,
  };
}

/* (Helper removed; reassignSales uses params.salesUsers.find directly.) */
