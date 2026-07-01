"use client";

// Lead Detail — three-column layout (PRD v3.2). page.tsx owns ALL data fetching,
// state, and event handlers; the three columns + bottom folding panel are pure
// presentational children. See .hermes/tasks/ld-three-column-refactor.md.
//
// Layout:  Left (3/12) CustomerProfile · Middle (5/12) SalesProcess · Right (4/12) Timeline
//          Bottom: LeadFoldingPanel (6 accordion blocks).

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSupabaseQuery } from "@/lib/supabaseQuery";
import { cn, fmtDubai } from "@/lib/utils";
import { toast, Toaster } from "sonner";
import { ArrowLeft, Trash2 } from "lucide-react";
import QuoteCalculator from "@/app/(dashboard)/quotes/quote-calculator";
import KnxDesignPanel from "@/components/knx-design-panel";
import { createFollowUpTask } from "@/lib/tasks";
import { MILESTONE_LABELS, MILESTONE_DESCRIPTIONS } from "@/lib/milestones";
import LeadCustomerProfile from "./LeadCustomerProfile";
import LeadSalesProcess from "./LeadSalesProcess";
import LeadTimeline from "./LeadTimeline";
import LeadFoldingPanel from "./LeadFoldingPanel";
import { projectDraftFromLead } from "./utils";
import type {
  Lead,
  Activity,
  BusinessEvent,
  ChatMessage,
  Task,
  FollowUpLog,
  LeadMilestone,
  LeadTrace,
  RenderInlineEdit,
  RenderDateEdit,
  RenderJsonEdit,
} from "./types";

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const { t, lang } = useLanguage();
  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [events, setEvents] = useState<BusinessEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [nextTask, setNextTask] = useState<Task | null>(null);
  const [leadTrace, setLeadTrace] = useState<LeadTrace[]>([]);
  const [transferHistory, setTransferHistory] = useState<any[]>([]);
  const [noteText, setNoteText] = useState("");
  const [followUpLogs, setFollowUpLogs] = useState<FollowUpLog[]>([]);
  const [leadMilestones, setLeadMilestones] = useState<LeadMilestone[]>([]);
  // Inline field-save status (Saving / Saved / Error) shown for any updateField call.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Project Info batch-save form (bottom folding panel) — local draft + status.
  const [projectInfoDraft, setProjectInfoDraft] = useState({
    project_type: "", emirate: "", area: "", ac_brand: "", customer_budget: "",
  });
  const [projectInfoStatus, setProjectInfoStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [showSalesDropdown, setShowSalesDropdown] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [markingPoor, setMarkingPoor] = useState(false);
  const [poorReasonText, setPoorReasonText] = useState("");
  const [showQuoteCalculator, setShowQuoteCalculator] = useState(false);
  // Bottom folding panel — which of the 6 blocks is open (null = all closed)
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const [salesRole, setSalesRole] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // P0-1 fetchData: 11 serial awaits → 2 parallel Promise.allSettled batches
  // ──────────────────────────────────────────────────────────────────────────
  // Batch 1 (1 HTTP): leads main + 5 embeds (creator/assignee profiles +
  //   follow_ups + milestones + business_events+operator + next_task)
  // Batch 2 (3 HTTP, parallel): activities (was Route Handler, now direct
  //   supabase) + chat_messages (RLS-sensitive, kept independent) +
  //   v_lead_trace (view has no PostgREST relation)
  // Promise.allSettled: per-query errors → console.warn (non-fatal), only
  //   the lead main query failure triggers setError (matches original
  //   "fetchData degraded" semantics from Q1 in the design §6.4 risk list).
  // Customers IIFE kept as a defensive no-op (all 49 leads have
  //   customer_id=NULL per §3A verification); preserves T1-8 maybeSingle=3.
  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const perfMark = typeof performance !== "undefined" ? performance.now() : 0;
    try {
      // Ensure auth session is set before any queries (fixes setSession race)
      await supabase.auth.getUser();

      // ─── BATCH 1: leads + 5 embeds in one HTTP request ─────────────────
      const leadPromise = supabase
        .from("leads")
        .select(
          `id, customer_name, phone, email, source, stage, lead_status,
           created_at, updated_at, created_by, assigned_to, customer_id,
           property_type, property_size_sqm, location, budget_range,
           service_needs, quotation_value, expected_close_date,
           expected_sign_date, win_probability, emirate, area, ac_brand,
           customer_budget, project_type, ai_summary, ai_tags, ai_quality,
           notes, lost_reason, lost_at, converted_at, final_status,
           next_action, next_followup_date, last_contact_date,
           followup_count, stage_changed_at, owner, sales_manager,
           decision_maker, decision_date, competitor, campaign_name,
           source_platform, source_channel, rep_name, quality, poor_reason,
           quotation_sent_date, circuit_diagrams, contact_result,
           smart_requirements, project_status,
           creator:profiles!fk_leads_created_by(id, full_name, email, role),
           assignee:profiles!fk_leads_assigned_to(id, full_name, email, role),
           follow_ups:follow_up_logs!follow_up_logs_lead_id_fkey(
             id, contact_type, summary, user_id, created_at
           ),
           milestones:lead_milestones!lead_milestones_lead_id_fkey(
             id, milestone_key, completed_at
           ),
           business_events:business_events!business_events_lead_id_fkey(
             id, event_type, event_data, description, created_at, user_id,
             operator:profiles!fk_business_events_user_id(id, full_name)
           ),
           next_task:tasks!tasks_lead_id_fkey(id, title, due_at)`
        )
        .eq("id", id)
        .maybeSingle();

      // ─── BATCH 2 (parallel to Batch 1): 3 independent queries ──────────
      // Activities — direct PostgREST instead of Route Handler (saves
      //   extra SSR + auth + service-client-rebuild hop).
      const activitiesPromise = supabase
        .from("activities")
        .select("id, lead_id, type, content, created_at, user_id, metadata")
        .eq("lead_id", id)
        .order("created_at", { ascending: false })
        .limit(30);

      // Chat messages — RLS-sensitive (sales role + owner check) so kept
      //   independent to avoid silent data loss via embed.
      const chatMessagesPromise = supabase
        .from("chat_messages")
        .select("id, content, direction, created_at")
        .eq("lead_id", id)
        .order("created_at", { ascending: false })
        .limit(100);

      // v_lead_trace — view has no PostgREST relation, must be independent.
      const leadTracePromise = supabase
        .from("v_lead_trace")
        .select("*")
        .eq("lead_id", id);

      // Run Batch 1 + Batch 2 in parallel. allSettled so a single failed
      //   sub-query does NOT abort the rest (matches original per-query
      //   console.warn behaviour — only lead main failure was fatal).
      const settled = await Promise.allSettled([
        leadPromise,
        activitiesPromise,
        chatMessagesPromise,
        leadTracePromise,
      ]);

      const [leadRes, activitiesRes, chatRes, traceRes] = settled;

      // ─── Rejection logging (network errors) ───────────────────────────
      // for...of so TS narrows PromiseSettledResult properly.
      for (const [i, s] of settled.entries()) {
        if (s.status === "rejected") {
          console.warn(`[LeadDetail] batch[${i}] promise rejected:`, s.reason);
        }
      }

      // ─── Lead main query — fatal on rejection OR fulfillment-with-error ─
      if (leadRes.status === "rejected") {
        console.error("[LeadDetail] fetch lead failed (rejected):", leadRes.reason);
        setError(t("common.loadFailedRetry"));
        return;
      }
      const leadPayload = leadRes.value;
      if (leadPayload.error) {
        console.error("[LeadDetail] fetch lead failed:", leadPayload.error);
        setError(t("common.loadFailedRetry"));
        return;
      }

      const l = leadPayload.data as any;
      if (l) {
        const creatorProfile = l.creator || null;
        const assigneeProfile = l.assignee || null;
        setLead({
          ...(l as unknown as Lead),
          creator_name: creatorProfile?.full_name || null,
          creator_profile: creatorProfile,
          assignee_profile: assigneeProfile,
        });
        setProjectInfoDraft(projectDraftFromLead(l));

        // Customers IIFE — defensive no-op for when customer_id becomes
        //   populated (FK fk_leads_customer_id now exists per migration
        //   B.1). Currently all 49 leads have customer_id=NULL so this
        //   branch never fires; kept for T1-8 maybeSingle=3 + future-proof.
        if (l.customer_id) {
          (async () => {
            const r = await supabase
              .from("customers")
              .select("id, name, email, phone")
              .eq("id", l.customer_id)
              .maybeSingle();
            if (r.data) {
              setLead((prev) =>
                prev ? ({ ...prev, customer: r.data } as Lead) : prev
              );
            }
          })().catch(() => {});
        }
      }

      // ─── Sub-table data from lead embed (Batch 1) ─────────────────────
      if (l?.follow_ups) setFollowUpLogs(l.follow_ups as FollowUpLog[]);
      if (l?.milestones) {
        setLeadMilestones(
          (l.milestones).map((m: any) => ({
            ...m,
            completed: !!m.completed_at,
          })) as LeadMilestone[]
        );
      }
      if (l?.business_events) {
        setEvents(l.business_events as BusinessEvent[]);
        const transfers = (l.business_events).filter(
          (ev: any) => ev.event_type === "transfer"
        );
        if (transfers.length > 0) setTransferHistory(transfers);
      }
      // next_task: embed can't filter (no .where/.is/.limit on embed),
      //   so filter + sort client-side to pick the next upcoming task.
      const nt = ((l?.next_task || []) as any[])
        .filter((t) => t.due_at != null)
        .sort((a, b) => (a.due_at > b.due_at ? 1 : -1))[0] || null;
      setNextTask(nt as Task | null);

      // ─── Independent queries from Batch 2 — soft-error handling ──────
      // Per design §6.4: original code wrapped each independent query in
      //   console.warn (non-fatal). allSettled + per-result check keeps
      //   the same semantics without blocking setError.
      const batches2 = [
        ["activities", activitiesRes],
        ["chat_messages", chatRes],
        ["v_lead_trace", traceRes],
      ] as const;
      for (const [name, r] of batches2) {
        if (r.status === "fulfilled") {
          const payload = r.value;
          if (payload.error) {
            console.warn(`[LeadDetail] non-fatal fetch (${name}):`, payload.error);
          } else if (payload.data) {
            if (name === "activities") setActivities(payload.data as Activity[]);
            else if (name === "chat_messages") setChatMessages(payload.data as ChatMessage[]);
            else if (name === "v_lead_trace") setLeadTrace(payload.data as LeadTrace[]);
          }
        }
        // rejected cases already logged above
      }

      if (perfMark && typeof performance !== "undefined") {
        console.info(
          `[LeadDetail] fetchData complete in ${(performance.now() - perfMark).toFixed(0)}ms`
        );
      }
    } catch (err) {
      console.warn("[LeadDetail] fetchData degraded:", err);
      setError(t("common.loadFailedRetry"));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Meta Pixel: track ViewContent when lead data loads
  useEffect(() => {
    if (lead && typeof window !== "undefined" && (window as any).fbq) {
      // Privacy-safe: only non-PII fields (no customer_name, no quotation_value)
      (window as any).fbq("track", "ViewContent", {
        content_ids: [id],
        content_type: "smart_home_lead",
        content_category: lead.stage || undefined,
      });
    }
  }, [lead, id]);

  useEffect(() => {
    supabase.from("profiles").select("id,email,role,full_name").in("role", ["admin", "sales", "operator"]).then(({ data }) => {
      if (data) setSalesUsers(data);
    });
  }, []);

  // Fetch current user role for delete visibility
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setCurrentUserId(user.id);
        const { data: profile, error: profileErr } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
        if (profileErr) console.warn("[LeadDetail] Failed to fetch current user profile (non-fatal):", profileErr);
        setSalesRole(profile?.role || "sales");
      }
    })();
  }, []);

  async function reassignSales(newUserId: string) {
    setReassigning(true);
    try {
      const oldLead = lead!;
      const newUser = salesUsers.find(u => u.id === newUserId);
      const oldUser = salesUsers.find(u => u.id === oldLead.assigned_to);
      const newUserName = newUser?.full_name || newUser?.email || newUserId;
      const oldName = oldUser?.full_name || oldUser?.email || oldLead.rep_name || "Unknown";
      // Update lead first — check error before side effects
      const { error: updateErr } = await supabase.from("leads").update({ assigned_to: newUserId, updated_at: new Date().toISOString() }).eq("id", id);
      if (updateErr) {
        console.error("[LeadDetail] reassign failed");
        toast.error(t("common.saveFailed"));
        return;
      }
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      await supabase.from("transfer_history").insert({ lead_id: id, from_user_id: oldLead.assigned_to, to_user_id: newUserId, reason: "manual_reassign", transferred_by: currentUser?.id });
      await supabase.from("activities").insert({ lead_id: id, type: "transfer", content: `Reassigned from ${oldName} to ${newUserName}`, user_id: currentUser?.id });
      await supabase.from("business_events").insert({ lead_id: id, event_type: "transfer", description: `Reassigned from ${oldName} to ${newUserName}`, user_id: currentUser?.id });
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "lead_assigned", lead_id: id, assigned_to: newUserId });
      });
      setLead({ ...oldLead, assigned_to: newUserId, rep_name: newUserName });
      setShowSalesDropdown(false);
    } finally {
      setReassigning(false);
    }
  }

  async function handleDelete() {
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
  }

  async function handleMarkPoor() {
    if (!poorReasonText.trim() || !lead) return;
    const { error } = await supabase.from("leads").update({
      quality: "poor",
      poor_reason: poorReasonText.trim(),
      updated_at: new Date().toISOString()
    }).eq("id", lead.id);
    if (error) { toast.error("Failed to mark poor"); return; }
    setMarkingPoor(false);
    setPoorReasonText("");
    router.refresh();
  }

  async function writeEvent(eventType: string, description: string, eventData?: Record<string, any>) {
    await supabase.from("business_events").insert({ lead_id: id, event_type: eventType, description, event_data: eventData || {}, user_id: (await supabase.auth.getUser()).data.user?.id });
  }

  async function updateField(field: string, value: any, eventType?: string, eventDesc?: string): Promise<boolean> {
    setUpdating(true);
    setSaveStatus("saving");
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    updates[field] = value;
    const { data: updated, error: err } = await supabase
      .from("leads")
      .update(updates)
      .eq("id", id)
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
      await supabase.from("activities").insert({ lead_id: id, type: eventType, content: eventDesc, user_id: (await supabase.auth.getUser()).data.user?.id });
      await writeEvent(eventType, eventDesc, { [field]: value });
    }
    setEditField(null);
    fetchData();
    setUpdating(false);
    setTimeout(() => setSaveStatus("idle"), 2500);
    return true;
  }

  // P1-6: batch-save the Project Info form (bottom folding panel) with explicit
  // Saving / Saved / Error feedback. Persists to the leads row; survives refresh.
  async function saveProjectInfo() {
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
      .eq("id", id)
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
        lead_id: id, type: "note_added", content: desc, user_id: user?.id ?? null,
      });
      await writeEvent("project_info_updated", desc, Object.fromEntries(changed.map((k) => [k, updates[k]])));
    }
    setProjectInfoStatus("saved");
    toast.success(lang === "zh" ? "项目信息已保存" : "Project info saved");
    fetchData();
    setTimeout(() => setProjectInfoStatus("idle"), 2500);
  }

  // Undo local Project Info edits — restore the draft to the last persisted
  // lead values (the same values the form was seeded with on fetch).
  function resetProjectInfoDraft() {
    setProjectInfoDraft(projectDraftFromLead(lead));
    setProjectInfoStatus("idle");
  }

  async function updateStage(stage: string): Promise<boolean> {
    // won/lost write final_status (trg_lead_won trigger fires on it);
    // other stages keep the legacy stage column (migrated in W7-W9).
    const field = stage === "won" || stage === "lost" ? "final_status" : "stage";
    return updateField(field, stage, "stage_change", `${t("leadDetail.eventTypes.stage_changed")} → ${t(`stageLabels.${stage}`)}`);
  }

  async function updateNextTask(updates: Partial<Pick<Task, "title" | "due_at">>) {
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
        leadId: id,
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
    fetchData();
  }

  async function handleWon() {
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
  }

  async function handleLost() {
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
  }

  // P0-1: notes are written to follow_up_logs (contact_type='note', summary=content,
  // user_id=author). The immutable follow-up log is the source of truth shown in the
  // timeline. Errors surface via toast so a failed insert never silently drops a note.
  async function addNote() {
    if (updating) return;
    const text = noteText.trim();
    if (!text) return;
    setUpdating(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from("follow_up_logs").insert({
      lead_id: id,
      user_id: user?.id ?? null,
      contact_type: "note",
      summary: text,
      no_answer: false,
    });
    if (insertError) {
      console.error("[LeadDetail] note save failed");
      setUpdating(false);
      toast.error(t("common.saveFailed"));
      return;
    }
    await supabase.from("leads").update({ last_contact_date: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
    setNoteText("");
    setUpdating(false);
    toast.success(lang === "zh" ? "备注已保存" : "Note saved");
    fetchData();
  }

  // Milestone toggle: complete the next pending milestone, or uncomplete a completed one
  async function toggleMilestone(milestoneKey: string, currentlyCompleted: boolean) {
    setUpdating(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (currentlyCompleted) {
      // Uncomplete: delete the milestone row
      const { error: delErr } = await supabase
        .from("lead_milestones")
        .delete()
        .eq("lead_id", id)
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
          lead_id: id,
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
    fetchData();
  }

  function openQuoteCalculator() {
    setShowQuoteCalculator(true);
  }

  // Create-contract shortcut — only reachable when final_status === "won"
  // (the SalesProcess column gates the button).
  function handleCreateContract() {
    if (!lead) return;
    const params = new URLSearchParams({ lead_id: lead.id });
    router.push(`/contracts/new?${params.toString()}`);
  }

  // Open the KNX design panel: scroll the embedded panel into view and trigger
  // its first button (same DOM-driven approach as the previous Overview tab).
  function handleGenerateKnx() {
    if (typeof document === "undefined") return;
    const knxPanel = document.querySelector('[data-knx-panel]');
    if (knxPanel) {
      knxPanel.scrollIntoView({ behavior: "smooth" });
      const btn = knxPanel.querySelector("button");
      if (btn) btn.click();
    }
  }

  if (loading) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={fetchData} />;
  if (!lead) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;

  // ─── Render helpers (page-owned so a single inline edit is active at a time) ───
  const renderInlineEdit: RenderInlineEdit = (field, label, type = "text") => {
    const value = (lead as any)[field];
    return editField === field ? (
      <div className="flex gap-1 mt-1">
        <input autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") updateField(field, editValue, "note_added", `${label}: ${editValue}`); if (e.key === "Escape") setEditField(null); }}
          className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
      </div>
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400"
        onClick={() => { setEditField(field); setEditValue(String(value ?? "")); }}>
        {value ? String(value) : <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  };

  const renderDateEdit: RenderDateEdit = (field, label) => {
    const value = (lead as any)[field];
    return editField === field ? (
      <input type="date" autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => { updateField(field, editValue || null, "note_added", `${label}: ${editValue || t("leadDetail.cleared")}`); }}
        className="w-full h-8 text-xs bg-muted border border-border rounded px-2 text-foreground mt-1" />
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400"
        onClick={() => { setEditField(field); setEditValue(value || ""); }}>
        {value ? fmtDubai(value, { locale: t("locale.dateLocale") }) : <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  };

  const renderJsonEdit: RenderJsonEdit = (field, label) => {
    const value = (lead as any)[field];
    let display: string | null = null;
    if (value != null) {
      try { display = typeof value === "string" ? value : JSON.stringify(value); }
      catch { display = String(value); }
    }
    return editField === field ? (
      <div className="flex gap-1 mt-1">
        <input autoFocus value={editValue} placeholder='{"rooms": 4, "lights": "KNX"}'
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              let parsed: any;
              if (!editValue) {
                parsed = null; // field cleared
              } else {
                try {
                  parsed = JSON.parse(editValue);
                } catch {
                  // Invalid JSON — fall back to the original value instead of
                  // saving the raw (garbled) string into the JSONB column.
                  parsed = value;
                }
              }
              updateField(field, parsed, "note_added", `${label}: ${editValue}`);
              setEditField(null);
            }
            if (e.key === "Escape") setEditField(null);
          }}
          className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
      </div>
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400 break-all text-xs"
        onClick={() => { setEditField(field); setEditValue(display || ""); }}>
        {display || <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  };

  // Next Required Action — date + title editors bound to nextTask (creates a task
  // when none exists via updateNextTask). Mirrors the old Details-tab editors.
  const renderNextFollowupDate = () =>
    editField === "next_followup_date" ? (
      <input type="date" autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => { if (editValue) updateNextTask({ due_at: editValue }); }}
        className="w-full h-8 text-xs bg-muted border border-border rounded px-2 text-foreground mt-1" />
    ) : (
      <p className={cn("mt-1 cursor-pointer hover:text-copper-400", !nextTask ? "text-rose-400 font-medium" : "text-foreground")}
        onClick={() => { setEditField("next_followup_date"); setEditValue(nextTask?.due_at.slice(0, 10) || ""); }}>
        {nextTask ? fmtDubai(nextTask.due_at, { locale: t("locale.dateLocale") }) : t("leadDetail.placeholderRequired")}
      </p>
    );

  const renderNextAction = () =>
    editField === "next_action" ? (
      <div className="flex gap-1 mt-1">
        <input autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && editValue.trim()) updateNextTask({ title: editValue.trim() }); if (e.key === "Escape") setEditField(null); }}
          className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
      </div>
    ) : (
      <p className={cn("mt-1 cursor-pointer hover:text-copper-400", !nextTask ? "text-rose-400 font-medium" : "text-foreground")}
        onClick={() => { setEditField("next_action"); setEditValue(nextTask?.title || ""); }}>
        {nextTask?.title || t("leadDetail.placeholderRequired")}
      </p>
    );

  // ═══════════════ MAIN RENDER ═══════════════
  if (loading) {
    return (
      <div className="max-w-7xl space-y-6">
        {/* Header skeleton */}
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-muted animate-pulse" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
        </div>

        {/* Three-column skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <aside className="lg:col-span-3 space-y-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </aside>

          <main className="lg:col-span-5 space-y-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          </main>

          <aside className="lg:col-span-4 space-y-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <Skeleton className="h-6 w-36" />
              <Skeleton className="h-48 w-full" />
            </div>
          </aside>
        </div>
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  if (!lead) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">{t("common.notFound")}</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl space-y-6">
      {/* Header: back + name + status badge + delete */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push("/leads")} className="text-muted-foreground">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">
              {lead.customer_name || lead.phone || t("leadDetail.unnamed")}
            </h1>
            {lead.lead_status && (
              <span className={cn("text-xs px-2 py-0.5 rounded font-medium",
                lead.lead_status === "hot" ? "bg-rose-500/10 text-rose-400" :
                lead.lead_status === "warm" ? "bg-amber-500/10 text-amber-400" :
                lead.lead_status === "cold" ? "bg-sky-500/10 text-sky-400" :
                "bg-gray-500/10 text-muted-foreground")}>
                {lead.lead_status === "hot" ? "🔥 " : lead.lead_status === "warm" ? "☀️ " : lead.lead_status === "cold" ? "❄️ " : "💤 "}
                {t(`statusLabels.${lead.lead_status}`)}
              </span>
            )}
            {lead.quality === 'poor' && (
              <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400">
                ⚠️ {t("leads.poorLead")}{lead.poor_reason && `: ${lead.poor_reason}`}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {fmtDubai(lead.created_at, { locale: t("locale.dateLocale") })} · {lead.source}
            {lead.rep_name && ` · ${lead.rep_name}`}
          </p>
        </div>
        {(salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && lead.assigned_to === currentUserId)) && (
          <>
          <Button variant="ghost" size="icon"
            className="text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
            onClick={handleDelete}
            title={t("common.delete") || "Delete"}>
            <Trash2 className="w-5 h-5" />
          </Button>
          {(salesRole === "admin" || salesRole === "boss") && (
            <Button variant="ghost" size="sm"
              className="text-amber-400 hover:bg-amber-500/10"
              onClick={() => { setMarkingPoor(true); }}
              title={t("leads.markPoor")}>
              ⚠️ {t("leads.markPoor")}
            </Button>
          )}
          </>
        )}
        {markingPoor && (
          <div className="flex items-center gap-2 mt-2">
            <input value={poorReasonText} onChange={e => setPoorReasonText(e.target.value)}
              placeholder={t("leads.poorReasonPlaceholder")} className="text-sm border border-border rounded px-2 py-1 bg-background" />
            <Button size="sm" variant="ghost" onClick={handleMarkPoor} className="text-amber-400">✓</Button>
            <Button size="sm" variant="ghost" onClick={() => setMarkingPoor(false)} className="text-muted-foreground">✗</Button>
          </div>
        )}
      </div>

      {/* Three-column grid: CustomerProfile (3) · SalesProcess (5) · Timeline (4) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3 space-y-4">
          <LeadCustomerProfile
            lead={lead}
            users={salesUsers}
            onUpdateField={updateField}
            onReassign={reassignSales}
            renderInlineEdit={renderInlineEdit}
            renderDateEdit={renderDateEdit}
            t={t}
            showSalesDropdown={showSalesDropdown}
            setShowSalesDropdown={setShowSalesDropdown}
            reassigning={reassigning}
            transferHistory={transferHistory}
          />
        </aside>

        <main className="lg:col-span-5 space-y-4">
          <LeadSalesProcess
            lead={lead}
            leadTrace={leadTrace}
            milestones={leadMilestones}
            nextTask={nextTask}
            updating={updating}
            onToggleMilestone={toggleMilestone}
            onUpdateField={updateField}
            onStageChange={updateStage}
            onWon={handleWon}
            onLost={handleLost}
            onOpenQuoteCalculator={openQuoteCalculator}
            onCreateContract={handleCreateContract}
            onGenerateKnx={handleGenerateKnx}
            renderInlineEdit={renderInlineEdit}
            renderDateEdit={renderDateEdit}
            renderJsonEdit={renderJsonEdit}
            renderNextFollowupDate={renderNextFollowupDate}
            renderNextAction={renderNextAction}
            t={t}
            lang={lang}
          />
          {/* KNX design panel — kept mounted so the "Generate KNX Plan" button
              (which drives it via the [data-knx-panel] selector) keeps working. */}
          <KnxDesignPanel leadId={id as string} />
        </main>

        <aside className="lg:col-span-4 space-y-4">
          <LeadTimeline
            activities={activities}
            events={events}
            followUpLogs={followUpLogs}
            chatMessages={chatMessages}
            noteText={noteText}
            onNoteTextChange={setNoteText}
            onAddNote={addNote}
            t={t}
            lang={lang}
          />
        </aside>
      </div>

      {/* Bottom folding panel — 6 collapsible blocks */}
      <LeadFoldingPanel
        lead={lead}
        openPanel={openPanel}
        onOpenPanelChange={setOpenPanel}
        projectInfoDraft={projectInfoDraft}
        onProjectInfoDraftChange={setProjectInfoDraft}
        projectInfoStatus={projectInfoStatus}
        onSaveProjectInfo={saveProjectInfo}
        onResetProjectInfo={resetProjectInfoDraft}
        renderJsonEdit={renderJsonEdit}
        t={t}
        lang={lang}
      />

      {showQuoteCalculator && (
        <QuoteCalculator
          open={showQuoteCalculator}
          onOpenChange={setShowQuoteCalculator}
          initialLeadId={id as string}
          onSaved={() => { fetchData(); }}
        />
      )}
      <Toaster position="top-center" richColors />
    </div>
  );
}
