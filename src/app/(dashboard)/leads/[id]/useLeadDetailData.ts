"use client";

/**
 * useLeadDetailData — T3-3 step 11 extracted from leads/[id]/page.tsx
 *
 * Encapsulates the read side of the Lead Detail three-column layout:
 *   - the lead row (with creator/assignee/follow_ups/milestones/business_events/next_task embeds)
 *   - activities, chat_messages, v_lead_trace (3 independent queries)
 *   - sales users list (for reassignment dropdown)
 *   - transfer history (derived from business_events embed)
 *   - projectInfoDraft (seeded from the lead row on fetch)
 *
 * P0-1 fetchData is preserved verbatim: 2 parallel Promise.allSettled batches,
 * non-fatal warn on sub-query failures, fatal setError only on lead-main failure.
 * Do NOT edit the Promise.allSettled block — it's the P0-1 perf baseline.
 *
 * Pure 1:1 move from page.tsx — no business logic changed.
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type {
  Lead,
  Activity,
  BusinessEvent,
  ChatMessage,
  Task,
  FollowUpLog,
  LeadMilestone,
  LeadTrace,
} from "./types";
import { projectDraftFromLead } from "./utils";

/* ─── Types ─── */
export interface ProjectInfoDraft {
  project_type: string;
  emirate: string;
  area: string;
  ac_brand: string;
  customer_budget: string;
}

export interface UseLeadDetailDataReturn {
  lead: Lead | null;
  setLead: React.Dispatch<React.SetStateAction<Lead | null>>;
  activities: Activity[];
  events: BusinessEvent[];
  chatMessages: ChatMessage[];
  nextTask: Task | null;
  leadTrace: LeadTrace[];
  transferHistory: any[];
  followUpLogs: FollowUpLog[];
  leadMilestones: LeadMilestone[];
  salesUsers: any[];
  projectInfoDraft: ProjectInfoDraft;
  setProjectInfoDraft: React.Dispatch<React.SetStateAction<ProjectInfoDraft>>;
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  fetchData: () => Promise<void>;
}

/* ─── Hook ─── */
export function useLeadDetailData(leadId: string): UseLeadDetailDataReturn {
  const supabase = createClient();
  const { t } = useLanguage();

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [events, setEvents] = useState<BusinessEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [nextTask, setNextTask] = useState<Task | null>(null);
  const [leadTrace, setLeadTrace] = useState<LeadTrace[]>([]);
  const [transferHistory, setTransferHistory] = useState<any[]>([]);
  const [followUpLogs, setFollowUpLogs] = useState<FollowUpLog[]>([]);
  const [leadMilestones, setLeadMilestones] = useState<LeadMilestone[]>([]);
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [projectInfoDraft, setProjectInfoDraft] = useState<ProjectInfoDraft>({
    project_type: "", emirate: "", area: "", ac_brand: "", customer_budget: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // P0-1 fetchData: 11 serial awaits → 2 parallel Promise.allSettled batches
  // ──────────────────────────────────────────────────────────────────────────
  // Batch 1 (1 HTTP): leads main + 4 embeds (creator/assignee profiles +
  //   follow_ups + milestones + business_events+operator)
  // Batch 2 (3 HTTP, parallel): activities (was Route Handler, now direct
  //   supabase) + chat_messages (RLS-sensitive, kept independent) +
  //   v_lead_trace (view has no PostgREST relation)
  // Promise.allSettled: per-query errors → console.warn (non-fatal), only
  //   the lead main query failure triggers setError (matches original
  //   "fetchData degraded" semantics from Q1 in the design §6.4 risk list).
  // Customers IIFE kept as a defensive no-op (all 49 leads have
  //   customer_id=NULL per §3A verification); preserves T1-8 maybeSingle=3.
  const fetchData = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    setError(null);
    const perfMark = typeof performance !== "undefined" ? performance.now() : 0;
    try {
      // Ensure auth session is set before any queries (fixes setSession race)
      await supabase.auth.getUser();

      // ─── BATCH 1: leads + 4 embeds in one HTTP request ─────────────────
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
             id, contact_type, summary, user_id, contact_time, contact_result, created_at
           ),
           milestones:lead_milestones!lead_milestones_lead_id_fkey(
             id, milestone_key, completed_at, completed_by, notes,
             completer:profiles!fk_lead_milestones_completed_by(id, full_name)
           ),
           business_events:business_events!business_events_lead_id_fkey(
             id, event_type, event_data, description, created_at, user_id,
             operator:profiles!fk_business_events_user_id(id, full_name)
           )`
        )
        .eq("id", leadId)
        .maybeSingle();

      // ─── Batch 2 (parallel to Batch 1): 3 independent queries ──────────
      // Activities — direct PostgREST instead of Route Handler (removes
      //   the extra Next.js/API hop and keeps it parallel with other reads).
      const activitiesPromise = supabase
        .from("activities")
        .select("id, lead_id, type, content, created_at, user_id, metadata")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(30);

      // Chat messages — RLS-sensitive (sales role + owner check) so kept
      //   independent to avoid silent data loss via embed.
      const chatMessagesPromise = supabase
        .from("chat_messages")
        .select("id, content, direction, created_at")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(100);

      // v_lead_trace — view has no PostgREST relation, must be independent.
      const leadTracePromise = supabase
        .from("v_lead_trace")
        .select("*")
        .eq("lead_id", leadId);

      // Next Required Action source of truth is tasks, not leads.next_action
      // or the unfiltered lead embed. Read the next open task directly.
      const nextTaskPromise = supabase
        .from("tasks")
        .select("id, title, due_at, completed_at")
        .eq("lead_id", leadId)
        .eq("status", "pending")
        .is("completed_at", null)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      // Run Batch 1 + Batch 2 in parallel. allSettled so a single failed
      //   sub-query does NOT abort the rest (matches original per-query
      //   console.warn behaviour — only lead main failure was fatal).
      const settled = await Promise.allSettled([
        leadPromise,
        activitiesPromise,
        chatMessagesPromise,
        leadTracePromise,
        nextTaskPromise,
      ]);

      const [leadRes, activitiesRes, chatRes, traceRes, nextTaskRes] = settled;

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

      if (nextTaskRes.status === "fulfilled") {
        const payload = nextTaskRes.value;
        if (payload.error) {
          console.warn("[LeadDetail] non-fatal fetch (tasks):", payload.error);
        } else {
          setNextTask((payload.data as Task | null) ?? null);
        }
      } else {
        setNextTask(null);
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
  }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchData(); }, [fetchData]);

  // Sales users for reassignment dropdown
  useEffect(() => {
    supabase.from("profiles").select("id,email,role,full_name").in("role", ["sales", "boss"]).then(({ data }) => {
      if (data) setSalesUsers(data);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    lead,
    setLead,
    activities,
    events,
    chatMessages,
    nextTask,
    leadTrace,
    transferHistory,
    followUpLogs,
    leadMilestones,
    salesUsers,
    projectInfoDraft,
    setProjectInfoDraft,
    loading,
    error,
    setError,
    fetchData,
  };
}
