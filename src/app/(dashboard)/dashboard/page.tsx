"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowUpRight, CheckCircle2,
} from "lucide-react";
import AlertPanel from "./_components/AlertPanel";
import { ErrorState } from "@/components/ui/error-state";

/* ─── Types ─── */
interface Lead {
  id: string; customer_name: string | null; phone: string | null;
  source: string; stage: string; final_status: string | null; quotation_value: number | null;
  location: string | null; property_type: string | null;
  ai_quality: string | null; lead_status: string | null;
  assigned_to: string | null; win_probability: number | null;
  last_contact_date: string | null; created_at: string; updated_at: string;
  next_followup_date: string | null; next_action: string | null;
  followup_count: number | null;
  recovery_candidate: boolean; transfer_candidate: boolean;
  sales_manager_review: boolean; hold_since: string | null;
  campaign_name: string | null; source_platform: string | null;
  owner: string | null; sales_manager: string | null;
}

interface Contract {
  id: string; contract_amount: number; status: string; created_at: string;
}

interface Payment {
  id: string; amount: number; confirmed: boolean; payment_date: string;
}

interface InstallmentPlan {
  id: string; amount: number; due_date: string; status: string; paid_amount: number | null;
}

interface FollowupTask {
  lead_id: string;
  due_at: string;
  leads: Lead | Lead[] | null;
}

/* ─── 9-stage funnel ─── */
const STAGE_KEYS = ["new","contacted","requirement_confirmed","solution_submitted","quotation_submitted","negotiation","pending_decision","won","lost"] as const;
const STAGE_COLORS: Record<string,string> = {
  new: "#6B7280", contacted: "#C48A52", requirement_confirmed: "#E0B95A",
  solution_submitted: "#4A5568", quotation_submitted: "#8B5CF6",
  negotiation: "#3B82F6", pending_decision: "#F59E0B", won: "#4ADE80", lost: "#6B7280",
};

function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v}`;
}

function daysSince(d: string | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

/* ─── Real financial data types ─── */
interface FinanceStats {
  totalContractValue: number;
  received: number;
  outstanding: number;
  overdue: number;
  dueNextWeek: number;
}

/* ════════════════════════════════════════ */
export default function DashboardPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t, lang: language } = useLanguage();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [teamOwnership, setTeamOwnership] = useState<any[]>([]);
  const [showActivityFeed, setShowActivityFeed] = useState(false);
  
  // Period & KPI targets
  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [period, setPeriod] = useState(currentPeriod);
  const [kpiTargets, setKpiTargets] = useState<any[]>([]);
  const lastPeriod = useMemo(() => {
    const [y, m] = period.split("-").map(Number);
    return m === 1 ? `${y-1}-12` : `${y}-${String(m-1).padStart(2, "0")}`;
  }, [period]);

  // User name lookup
  const userNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    salesUsers.forEach((u: any) => { if (u.id && u.full_name) map[u.id] = u.full_name; });
    return map;
  }, [salesUsers]);

  // Real financial data
  const [financeStats, setFinanceStats] = useState<FinanceStats>({
    totalContractValue: 0,
    received: 0,
    outstanding: 0,
    overdue: 0,
    dueNextWeek: 0,
  });
  const [financeLoading, setFinanceLoading] = useState(true);
  const [contractCount, setContractCount] = useState(0);

  // Risk pool
  const [riskPoolCount, setRiskPoolCount] = useState<number | null>(null);
  // Today's follow-up
  const [todayFollowups, setTodayFollowups] = useState<Lead[]>([]);
  const [followupLoading, setFollowupLoading] = useState(true);

  // Top 5 Actions
  interface TopAction { type: string; title: string; subtitle: string; link: string; priority: "high" | "medium" | "low"; customerName: string; value: number; reason: string; phone: string | null; leadId: string; }
  const [topActions, setTopActions] = useState<TopAction[]>([]);

  const fetchLeads = useCallback(async () => {
    // Circuit-breaker: do NOT query until role is resolved.
    // A sales user running unfiltered query would see all leads.
    if (userRole === null) return;
    setLoading(true);
    setError(null);
    let query = supabase.from("leads").select("*");
    if (userRole === "sales" && userId) {
      query = query.eq("assigned_to", userId);
    }
    const { data: l, error: err } = await query.order("updated_at", { ascending: false }).limit(500);
    if (err) { console.error("Failed to fetch leads:", err); setError(t("common.loadFailedRetry")); setLoading(false); return; }
    if (l) setLeads(l as Lead[]);
    setLoading(false);
  }, [supabase, userId, userRole, language]);

  const fetchFinancialData = useCallback(async () => {
    // Circuit-breaker: same as fetchLeads — wait for role resolution.
    if (userRole === null) return;
    setFinanceLoading(true);
    try {
      // 1. Contract Value: sum of contract_amount where status != 'terminated'
      //    Must complete first to get contractIds for downstream filters
      let contractQuery = supabase
        .from("contracts")
        .select("id,contract_amount,status,created_at");
      if (userRole === "sales" && userId) {
        contractQuery = contractQuery.eq("sales_id", userId);
      }
      const { data: contracts, error: cErr } = await contractQuery;
      if (cErr) throw cErr;

      const activeContracts = (contracts as Contract[] || []).filter(c => c.status !== "terminated");
      const totalContractValue = activeContracts.reduce((sum, c) => sum + (c.contract_amount || 0), 0);
      setContractCount(activeContracts.length);

      // Collect contract IDs for downstream filters
      const contractIds = (contracts as Contract[] || []).map(c => c.id);

      // Compute date boundaries shared by overdue / dueNextWeek queries
      const now = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const nextWeekStr = nextWeek.toISOString().split("T")[0];

      // 2-4. Run independent queries in parallel: payments, overdue, dueNextWeek
      let paymentsQuery = supabase
        .from("payments")
        .select("amount,confirmed,payment_date");
      if (userRole === "sales" && userId && contractIds.length > 0) {
        paymentsQuery = paymentsQuery.in("contract_id", contractIds);
      }

      let overdueQuery = supabase
        .from("installment_plans")
        .select("amount,due_date,status,paid_amount")
        .lt("due_date", now)
        .neq("status", "paid");
      if (userRole === "sales" && userId && contractIds.length > 0) {
        overdueQuery = overdueQuery.in("contract_id", contractIds);
      }

      let dueQuery = supabase
        .from("installment_plans")
        .select("amount,due_date,status,paid_amount")
        .gte("due_date", now)
        .lte("due_date", nextWeekStr)
        .eq("status", "pending");
      if (userRole === "sales" && userId && contractIds.length > 0) {
        dueQuery = dueQuery.in("contract_id", contractIds);
      }

      const [
        { data: payments, error: pErr },
        { data: overduePlans, error: oErr },
        { data: duePlans, error: dErr },
      ] = await Promise.all([
        paymentsQuery,
        overdueQuery,
        dueQuery,
      ]);

      if (pErr) throw pErr;
      if (oErr) throw oErr;
      if (dErr) throw dErr;

      // Compute derived values
      const confirmedPayments = (payments as Payment[] || []).filter(p => p.confirmed === true);
      const received = confirmedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
      const outstanding = totalContractValue - received;
      const overdue = (overduePlans as InstallmentPlan[] || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      const dueNextWeek = (duePlans as InstallmentPlan[] || []).reduce((sum, p) => sum + (p.amount || 0), 0);

      setFinanceStats({
        totalContractValue: Math.round(totalContractValue),
        received: Math.round(received),
        outstanding: Math.round(outstanding),
        overdue: Math.round(overdue),
        dueNextWeek: Math.round(dueNextWeek),
      });
    } catch (err) {
      console.error("Failed to fetch financial data:", err);
    }
    setFinanceLoading(false);
  }, [supabase, userId, userRole, language]);

  // Fetch sales users for name mapping
  useEffect(() => {
    supabase.from("profiles").select("id,email,role,full_name").in("role", ["admin", "sales", "operator", "boss"]).then(({ data }) => {
      if (data) setSalesUsers(data);
    });
  }, []);

  // Fetch team ownership
  useEffect(() => {
    fetch("/api/dashboard/team-ownership").then(r => r.json()).then(d => {
      if (d.users) setTeamOwnership(d.users);
    }).catch((e) => console.error("team-ownership fetch failed", e));
  }, []);

  // Fetch KPI targets for selected period
  useEffect(() => {
    supabase.from("kpi_targets").select("*").eq("period", period).then(({ data }) => {
      if (data) setKpiTargets(data);
    });
  }, [supabase, period]);
  useEffect(() => {
    (async () => {
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user) return;
      setUserId(user.id);
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      if (profile) setUserRole(profile.role);
    })();
  }, [supabase]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);
  useEffect(() => { fetchFinancialData(); }, [fetchFinancialData]);

  // Fetch risk pool & today's follow-ups
  useEffect(() => {
    if (!userId) return; // wait for user info before fetching
    (async () => {
      // Try v_risk_pool view first, fallback to direct query
      try {
        const { data: riskData } = await supabase.from("v_risk_pool").select("count", { count: "exact", head: true });
        if (riskData !== null) {
          // count is approximate from head:true
          const { count } = await supabase.from("v_risk_pool").select("*", { count: "exact", head: true });
          setRiskPoolCount(count || 0);
        } else {
          throw new Error("view not found");
        }
      } catch {
        // Fallback: query leads directly for overdue/missing followups
        const now = new Date().toISOString();
        let riskQuery = supabase
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .is("completed_at", null)
          .lt("due_at", now);
        if (userRole === "sales" && userId) {
          riskQuery = riskQuery.eq("assignee_id", userId);
        }
        const { count } = await riskQuery;
        setRiskPoolCount(count || 0);
      }

      // Today's follow-ups
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const tomorrowStart = new Date(todayStart);
      tomorrowStart.setDate(tomorrowStart.getDate() + 1);
      let followupQuery = supabase
        .from("tasks")
        .select("lead_id, due_at, leads!inner(*)")
        .is("completed_at", null)
        .gte("due_at", todayStart.toISOString())
        .lt("due_at", tomorrowStart.toISOString());
      if (userRole === "sales" && userId) {
        followupQuery = followupQuery.eq("assignee_id", userId);
      }
      const { data: followups } = await followupQuery.order("due_at");
      if (followups) {
        setTodayFollowups((followups as FollowupTask[]).flatMap((task) => {
          const lead = Array.isArray(task.leads) ? task.leads[0] : task.leads;
          return lead && !lead.final_status ? [lead] : [];
        }));
      }
      setFollowupLoading(false);

      // Top 5 Actions: overdue followups, hot leads, high-value stale, draft quotes, expiring quotes
      const actions: TopAction[] = [];

      // 1. Overdue followups — incomplete tasks with a past due_at
      try {
        const now = new Date().toISOString();
        let followupQ = supabase
          .from("tasks")
          .select("lead_id, due_at, leads!inner(id, customer_name, quotation_value, last_contact_date, phone, final_status)")
          .is("completed_at", null)
          .lt("due_at", now)
          .order("due_at", { ascending: true })
          .limit(5);
        if (userRole === "sales" && userId) followupQ = followupQ.eq("assignee_id", userId);
        const { data: overdueFollowups } = await followupQ;
        if (overdueFollowups) {
          (overdueFollowups as FollowupTask[]).forEach((task) => {
            const l = Array.isArray(task.leads) ? task.leads[0] : task.leads;
            if (!l || l.final_status) return;
            const daysLate = Math.ceil((Date.now() - new Date(task.due_at).getTime()) / 86400000);
            actions.push({
              type: "overdue_followup",
              title: l.customer_name || t("common.unnamed"),
              subtitle: `${l.customer_name || t("common.unnamed")} · ${t("dashboard.overdueFollowup").replace("{n}", String(daysLate))}`,
              link: `/leads/${l.id}`,
              priority: daysLate >= 3 ? "high" : "medium",
              customerName: l.customer_name || t("common.unnamed"),
              value: l.quotation_value || 0,
              reason: t("dashboard.overdueFollowup").replace("{n}", String(daysLate)),
              phone: l.phone || null,
              leadId: l.id,
            });
          });
        }
      } catch (e) { console.error("top-actions overdue followups failed", e); }

      // 2. Hot leads — leads with lead_status='hot' and high win_probability, not yet won/lost
      try {
        let hotQ = supabase
          .from("leads")
          .select("id, customer_name, quotation_value, win_probability, stage, phone")
          .eq("lead_status", "hot")
          .is("final_status", null)
          .order("quotation_value", { ascending: false })
          .limit(3);
        if (userRole === "sales" && userId) hotQ = hotQ.eq("assigned_to", userId);
        const { data: hotLeads } = await hotQ;
        if (hotLeads) {
          hotLeads.forEach((l: any) => {
            actions.push({
              type: "hot_lead",
              title: l.customer_name || t("common.unnamed"),
              subtitle: `${l.customer_name || t("common.unnamed")} · ${t("dashboard.winProb").replace("{n}", String(l.win_probability || 0))}`,
              link: `/leads/${l.id}`,
              priority: (l.win_probability || 0) >= 70 ? "high" : "medium",
              customerName: l.customer_name || t("common.unnamed"),
              value: l.quotation_value || 0,
              reason: t("dashboard.hotLeadPriority"),
              phone: l.phone || null,
              leadId: l.id,
            });
          });
        }
      } catch (e) { console.error("top-actions hot leads failed", e); }

      // 3. Draft quotes pending — from quotations table
      try {
        let qQ = supabase.from("quotations").select("*, leads!inner(customer_name, quotation_value, id, phone)")
          .eq("status", "draft")
          .order("total_amount", { ascending: false })
          .limit(3);
        if (userRole === "sales" && userId) qQ = qQ.eq("created_by", userId);
        const { data: drafts } = await qQ;
        if (drafts) {
          drafts.forEach((q: any) => {
            actions.push({
              type: "quote_draft",
              title: q.leads?.customer_name || t("common.unnamed"),
              subtitle: `${q.leads?.customer_name || t("common.unnamed")} · ${q.quote_no || t("dashboard.draftQuote")}`,
              link: `/quotes`,
              priority: "medium",
              customerName: q.leads?.customer_name || t("common.unnamed"),
              value: q.total_amount || 0,
              reason: t("dashboard.draftQuotePending"),
              phone: q.leads?.phone || null,
              leadId: q.leads?.id || "",
            });
          });
        }
      } catch (e) { console.error("top-actions draft quotes failed", e); }

      // 4. High-value stale leads — no contact in 48h+, sorted by quotation_value
      try {
        const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        let sQ = supabase.from("leads").select("id, customer_name, quotation_value, last_contact_date, stage, phone")
          .is("final_status", null)
          .or(`last_contact_date.lt.${cutoff},last_contact_date.is.null`)
          .order("quotation_value", { ascending: false })
          .limit(3);
        if (userRole === "sales" && userId) sQ = sQ.eq("assigned_to", userId);
        const { data: stale } = await sQ;
        if (stale) {
          stale.forEach((l: any) => {
            const daysInactive = l.last_contact_date
              ? Math.ceil((Date.now() - new Date(l.last_contact_date).getTime()) / 86400000)
              : 99;
            actions.push({
              type: "stale_lead",
              title: l.customer_name || t("common.unnamed"),
              subtitle: `${l.customer_name || t("common.unnamed")} · ${t("dashboard.dInactive").replace("{n}", String(daysInactive))}`,
              link: `/leads/${l.id}`,
              priority: daysInactive > 7 ? "high" : "medium",
              customerName: l.customer_name || t("common.unnamed"),
              value: l.quotation_value || 0,
              reason: t("dashboard.dNoReply").replace("{n}", String(daysInactive)),
              phone: l.phone || null,
              leadId: l.id,
            });
          });
        }
      } catch (e) { console.error("top-actions stale leads failed", e); }

      // 5. Overdue workflow stages (complementary signal)
      try {
        let wfQ = supabase.from("lead_workflow_stages").select("*, leads!inner(customer_name, quotation_value, phone)")
          .eq("status", "in_progress")
          .lt("deadline_at", new Date().toISOString())
          .order("deadline_at", { ascending: true })
          .limit(3);
        if (userRole === "sales" && userId) {
          wfQ = wfQ.eq("assigned_to", userId);
        }
        const { data: overdueWf } = await wfQ;
        if (overdueWf) {
          overdueWf.forEach((w: any) => {
            const leadName = w.leads?.customer_name || t("common.unnamed");
            actions.push({
              type: "workflow_overdue",
              title: leadName,
              subtitle: `${leadName} · ${t("dashboard.stageOverdue").replace("{stage}", t("stageLabels." + w.stage_key))}`,
              link: `/leads/${w.lead_id}`,
              priority: "high",
              customerName: leadName,
              value: w.leads?.quotation_value || 0,
              reason: t("dashboard.workflowOverdue"),
              phone: w.leads?.phone || null,
              leadId: w.lead_id,
            });
          });
        }
      } catch (e) { console.error("top-actions overdue workflow failed", e); }

      // Sort by priority score (value × urgency multiplier) and deduplicate by lead link
      const seenLinks = new Set<string>();
      const priorityScore = (a: TopAction): number => {
        const urgencyMult = a.priority === "high" ? 3 : a.priority === "medium" ? 2 : 1;
        return a.value * urgencyMult;
      };
      const sorted = actions
        .sort((a, b) => priorityScore(b) - priorityScore(a))
        .filter((a) => {
          // Deduplicate: keep first occurrence per link
          if (seenLinks.has(a.link)) return false;
          seenLinks.add(a.link);
          return true;
        });

      setTopActions(sorted.slice(0, 5));
    })();
  }, [userId, userRole, language]);

  /* ─── Computed ─── */
  const stats = useMemo(() => {
    const active = leads;
    const now = new Date();

    const stageCounts: Record<string, number> = {};
    const stageValues: Record<string, number> = {};
    for (const key of STAGE_KEYS) {
      // won/lost now live in final_status; process stages in stage. The
      // `final_status || stage` fallback buckets each lead exactly once
      // (won/lost leads short-circuit on final_status, never a process key).
      const items = active.filter(l => (l.final_status || l.stage) === key);
      stageCounts[key] = items.length;
      stageValues[key] = items.reduce((sum, l) => sum + (l.quotation_value || 0), 0);
    }

    const pipeline = active.filter(l => !l.final_status);
    const totalPipeline = pipeline.reduce((sum, l) => sum + (l.quotation_value || 0), 0);
    const weightedPipeline = pipeline.reduce((sum, l) => sum + (l.quotation_value || 0) * (l.win_probability || 0) / 100, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const wonThisMonth = active.filter(l => l.final_status === "won" && l.updated_at && new Date(l.updated_at) >= monthStart);
    const monthlyRevenue = wonThisMonth.reduce((sum, l) => sum + (l.quotation_value || 0), 0);

    const yellowLeads = pipeline.filter(l => { const d = daysSince(l.last_contact_date || l.updated_at); return d !== null && d >= 7 && d < 14; });
    const redLeads = pipeline.filter(l => { const d = daysSince(l.last_contact_date || l.updated_at); return d !== null && d >= 14; });

    const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
    const newThisWeek = active.filter(l => l.created_at && new Date(l.created_at) >= weekStart).length;

    const contactedTotal = stageCounts.contacted + stageCounts.requirement_confirmed + stageCounts.solution_submitted + stageCounts.quotation_submitted + stageCounts.negotiation + stageCounts.pending_decision + stageCounts.won;
    const conversionRate = contactedTotal > 0 ? Math.round((stageCounts.won / contactedTotal) * 100) : 0;

    const recoveryCount = pipeline.filter(l => l.recovery_candidate).length;
    const transferCount = pipeline.filter(l => l.transfer_candidate).length;
    const reviewCount = pipeline.filter(l => l.sales_manager_review).length;
    const highProbStale = pipeline.filter(l => { const d = daysSince(l.last_contact_date || l.updated_at); return (l.win_probability || 0) >= 70 && d !== null && d >= 14; }).length;
    const pendingStale = active.filter(l => { if (l.stage !== "pending_decision") return false; const d = daysSince(l.hold_since || l.updated_at); return d !== null && d >= 30; }).length;

    const statusCounts: Record<string, number> = {};
    for (const l of active) { const s = l.lead_status || "unknown"; statusCounts[s] = (statusCounts[s] || 0) + 1; }

    const sourceCounts: Record<string, number> = {};
    const sourceWon: Record<string, number> = {};
    for (const l of active) {
      const src = l.source_platform || l.source || "other";
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      if (l.final_status === "won") sourceWon[src] = (sourceWon[src] || 0) + 1;
    }

    const wonCount = stageCounts.won || 0;
    const contactRate = active.length > 0 ? Math.round(((stageCounts.contacted || 0) + (stageCounts.requirement_confirmed || 0)) / active.length * 100) : 0;

    return {
      totalActive: active.length,
      stageCounts, stageValues,
      pipelineSize: pipeline.length,
      totalPipeline, weightedPipeline,
      monthlyRevenue, wonCount,
      newThisWeek, conversionRate,
      yellowCount: yellowLeads.length,
      redCount: redLeads.length,
      recoveryCount, transferCount, reviewCount, highProbStale, pendingStale,
      statusCounts, sourceCounts, sourceWon,
      contactRate,
    };
  }, [leads]);

  // ─── KPI-driven finance cards — completion % FIRST ───
  // Company-level targets (for boss/admin view)
  const companySigningTarget = kpiTargets.find((t: any) => t.target_type === "signing" && !t.assigned_to)?.target_amount || 0;
  const companyCollectionTarget = kpiTargets.find((t: any) => t.target_type === "collection" && !t.assigned_to)?.target_amount || 0;
  // Personal targets (for sales view)
  const mySigningTarget = kpiTargets.find((t: any) => t.target_type === "signing" && t.assigned_to === userId)?.target_amount || 0;
  const myCollectionTarget = kpiTargets.find((t: any) => t.target_type === "collection" && t.assigned_to === userId)?.target_amount || 0;
  // Sales sees personal targets, management sees company targets
  const signingTarget = userRole === "sales" ? mySigningTarget : companySigningTarget;
  const collectionTarget = userRole === "sales" ? myCollectionTarget : companyCollectionTarget;

  // Actuals: sales only counts their own, management counts all
  const myWonLeads = leads.filter(l => l.assigned_to === userId && l.final_status === "won");
  const mySigningActual = myWonLeads.reduce((sum, l) => sum + (l.quotation_value || 0), 0);
  const signingActual = userRole === "sales" ? mySigningActual : (financeStats.received + financeStats.outstanding);
  const myCollectionActual = financeStats.received; // TODO: filter by sales_id when finance supports it
  const collectionActual = userRole === "sales" ? myCollectionActual : financeStats.received;
  const signingPct = signingTarget > 0 ? Math.round((signingActual / signingTarget) * 100) : null;
  const collectionPct = collectionTarget > 0 ? Math.round((collectionActual / collectionTarget) * 100) : null;

  // Time-proportional expected progress (monthly)
  const expectedPct = useMemo(() => {
    const now = new Date();
    const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return Math.round((now.getDate() / totalDays) * 100);
  }, []);

  const pctColor = (v: number | null) => {
    if (v === null || v === 0) return "text-muted-foreground";
    if (v >= expectedPct) return "text-emerald-400";
    return "text-amber-400";
  };
  const barColor = (v: number | null) => {
    if (v === null || v === 0) return "bg-muted";
    if (v >= expectedPct) return "bg-emerald-500";
    return "bg-amber-500";
  };

  // Market: source breakdown
  const sourceBreakdown = useMemo(() => {
    const sources: Record<string, { total: number; won: number; value: number }> = {};
    leads.forEach(l => {
      const s = l.source || "unknown";
      if (!sources[s]) sources[s] = { total: 0, won: 0, value: 0 };
      sources[s].total++;
      if (l.final_status === "won") sources[s].won++;
      if (l.quotation_value) sources[s].value += l.quotation_value;
    });
    const sourceLabels: Record<string, string> = { meta_ads: t("sourceLabels.meta_ads"), whatsapp: t("sourceLabels.whatsapp"), other: t("sourceLabels.other"), unknown: t("sourceLabels.unknown") };
    return Object.entries(sources)
      .map(([k, v]) => ({ source: k, label: sourceLabels[k] || k, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [leads]);
  const maxSourceTotal = Math.max(...sourceBreakdown.map(s => s.total), 1);
  
  // Per-salesperson breakdown
  const salesLeaderboard = useMemo(() => {
    const sales = salesUsers.filter((u: any) => u.role === "sales");
    return sales.map((s: any) => {
      const target = kpiTargets.find((t: any) => t.target_type === "signing" && t.assigned_to === s.id);
      const salesLeads = leads.filter(l => l.assigned_to === s.id);
      const activeLeads = salesLeads.filter(l => !l.final_status);
      const wonLeads = salesLeads.filter(l => l.final_status === "won");
      const wonValue = wonLeads.reduce((sum, l) => sum + (l.quotation_value || 0), 0);
      const pipelineValue = activeLeads.reduce((sum, l) => sum + (l.quotation_value || 0), 0);
      const contacted = salesLeads.filter(l =>
        !l.final_status && ["contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision"].includes(l.stage)
      ).length;
      const conversionRate = salesLeads.length > 0 ? Math.round((wonLeads.length / salesLeads.length) * 100) : 0;
      const targetAmount = target?.target_amount || 0;
      const completionRate = targetAmount > 0 ? Math.round((wonValue / targetAmount) * 100) : 0;
      return {
        id: s.id,
        name: s.full_name || s.email || t("common.unnamed"),
        wonValue,
        wonCount: wonLeads.length,
        pipelineValue,
        activeCount: activeLeads.length,
        totalLeads: salesLeads.length,
        contacted,
        conversionRate,
        targetAmount,
        completionRate,
      };
    }).sort((a, b) => b.wonValue - a.wonValue);
  }, [salesUsers, leads, kpiTargets]);

  // KPI-driven finance cards — replaces old kpiCards + financeCards
  const getKpiSub = (actual: number, target: number) => {
    if (target <= 0) return t("kpi.noTargetSet");
    const pct = Math.round((actual / target) * 100);
    return `${t("dashboard.completionRate")} ${pct}% · ${t("dashboard.target2")} ${fmtAED(target)}`;
  };

  // No more financeCards array — render L1 cards inline

  if (loading) return <div className="flex items-center justify-center h-64 text-muted-foreground">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={fetchLeads} />;

  const overdueCount = (stats.redCount || 0) + (stats.yellowCount || 0);
  const isManagement = userRole !== "sales";

  /* ─── shared: alert banner ─── */
  const AlertBanner = overdueCount > 0 && (
    <div className="px-5 py-3 rounded-xl flex items-center justify-between bg-red-500/10 border border-red-500/20">
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
        <span className="text-sm text-red-300 font-medium">
          {t("dashboard.overdueAlert").replace("{n}", String(overdueCount))}
        </span>
      </div>
      <button onClick={() => router.push("/leads?alert=red")}
        className="text-sm font-medium text-copper-400 hover:text-copper-300 transition-colors">
        {t("dashboard.viewAlerts")} →
      </button>
    </div>
  );

  /* ─── shared: header ─── */
  const headerTitle = isManagement ? t("dashboard.title") : t("nav.salesDashboard");
  const headerSub = isManagement
    ? `${signingTarget > 0 ? `${t("dashboard.signingTarget")} ${fmtAED(signingTarget)}` : t("dashboard.noTargetSet")} · ${collectionTarget > 0 ? `${t("dashboard.collectionTarget")} ${fmtAED(collectionTarget)}` : t("dashboard.noTargetSet")}`
    : `${signingTarget > 0 ? `${t("dashboard.myTarget")} ${fmtAED(signingTarget)}` : t("dashboard.noTargetSet")} · ${signingPct !== null ? `${t("dashboard.pctComplete").replace("{n}", String(signingPct))}` : ""}`;

  const Header = (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 className="text-xl font-bold text-foreground tracking-tight">
          {headerTitle}
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {headerSub}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="h-9 px-3 text-sm rounded-lg border border-border/50 bg-background text-foreground"
        >
          {(() => {
            const opts: string[] = [];
            const now = new Date();
            for (let i = 0; i < 12; i++) {
              const y = now.getFullYear();
              const m = now.getMonth() - i; // 0-indexed, can be negative
              const d = new Date(y, m, 1);
              // Format as YYYY-MM in local timezone (avoid toISOString UTC shift)
              const mm = String(d.getMonth() + 1).padStart(2, "0");
              opts.push(`${d.getFullYear()}-${mm}`);
            }
            return opts.map(m => <option key={m} value={m}>{m}</option>);
          })()}
        </select>
        <button
          onClick={() => { window.location.href = "/leads/new"; }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/85 transition-colors"
        >
          + {t("dashboard.newLeads")}
        </button>
      </div>
    </div>
  );

  /* ─── shared: KPI mini stat cards ─── */
  const KpiStatCards = (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
      {[
        { label: t("dashboard.kpiLeads"), value: String(stats.totalActive), sub: t("dashboard.plusNwk").replace("{n}", String(stats.newThisWeek)), href: "/leads" },
        { label: t("dashboard.kpiActive"), value: String(contractCount), sub: t("dashboard.nPipeline").replace("{n}", String(stats.pipelineSize)), href: "/leads?stage=negotiation" },
        { label: t("dashboard.kpiQuotes"), value: String(stats.stageCounts.quotation_submitted + stats.stageCounts.negotiation + stats.stageCounts.pending_decision), sub: t("dashboard.nPending").replace("{n}", String(stats.stageCounts.quotation_submitted)), href: "/quotes" },
        { label: t("dashboard.pipelineValue"), value: fmtAED(stats.totalPipeline), sub: t("dashboard.nDeals").replace("{n}", String(stats.pipelineSize)), href: "/leads?stage=quotation_submitted" },
        { label: t("dashboard.won"), value: fmtAED(stats.monthlyRevenue), sub: t("dashboard.nClosed").replace("{n}", String(stats.wonCount)), href: "/leads?stage=won" },
        { label: t("dashboard.kpiConv"), value: `${stats.conversionRate}%`, sub: t("dashboard.nPctContacted").replace("{n}", String(stats.contactRate)), href: "/leads" },
      ].map(card => (
        <button key={card.label}
          onClick={() => router.push(card.href)}
          className="p-3 rounded-lg border border-border/50 bg-card/50 hover:bg-accent/30 transition-all text-left group"
        >
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">{card.label}</p>
          <p className="text-lg font-bold text-foreground group-hover:text-copper-400 transition-colors">{card.value}</p>
          <p className="text-[10px] text-emerald-400/70">{card.sub}</p>
        </button>
      ))}
    </div>
  );

  /* ─── quick action handlers ─── */
  const handleWhatsApp = (phone: string, customerName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const clean = phone.replace(/[^0-9+]/g, "");
    window.open(`https://wa.me/${clean}`, "_blank");
  };
  const handleCall = (phone: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const clean = phone.replace(/[^0-9+]/g, "");
    window.open(`tel:${clean}`, "_self");
  };
  const handleQuickLog = async (leadId: string, customerName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const note = prompt(`${t("dashboard.logFollowup")} — ${customerName}`);
    if (!note) return;
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from("activities").insert({
        lead_id: leadId,
        type: "followup",
        content: note,
        user_id: user?.id,
        created_at: new Date().toISOString(),
      });
      alert(t("dashboard.activityLogged"));
    } catch { alert(t("common.operationFailed")); }
  };
  const formatWhatsApp = (phone: string | null | undefined): string => {
    if (!phone) return "";
    return phone.replace(/[^0-9+]/g, "").replace(/^0+/, "");
  };

  /* ─── shared: today's actions list ─── */
  const TodayActions = (
    <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
      {topActions.length > 0 ? (
        <div className="divide-y divide-border/30">
          {topActions.map((action, i) => (
            <div key={i}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors text-left group cursor-pointer"
              onClick={() => router.push(action.link)}
            >
              <div className={cn(
                "w-1 h-10 rounded-full shrink-0",
                action.priority === "high" ? "bg-red-400" : "bg-amber-400"
              )} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground group-hover:text-copper-400 transition-colors">
                  {action.customerName}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  {action.value > 0 && (
                    <span className="text-xs font-medium text-copper-400">{fmtAED(action.value)}</span>
                  )}
                  <span className="text-xs text-muted-foreground">{action.reason}</span>
                </div>
              </div>
              {/* Action buttons */}
              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                {action.phone && (
                  <>
                    <button
                      onClick={(e) => handleWhatsApp(action.phone!, action.customerName, e)}
                      className="p-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 transition-colors"
                      title={t("dashboard.openWhatsApp")}
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                    </button>
                    <button
                      onClick={(e) => handleCall(action.phone!, e)}
                      className="p-1.5 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 transition-colors"
                      title={t("dashboard.callPhone")}
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                    </button>
                  </>
                )}
                {action.leadId && (
                  <button
                    onClick={(e) => handleQuickLog(action.leadId, action.customerName, e)}
                    className="p-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 transition-colors"
                    title={t("dashboard.logFollowup")}
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-5 py-6 text-center">
          <CheckCircle2 className="w-8 h-8 text-emerald-400/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">{t("dashboard.allClear")}</p>
        </div>
      )}
    </div>
  );

  /* ─── shared: section header ─── */
  const SectionHeader = ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-1 h-4 rounded-full bg-copper-400" />
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
    </div>
  );

  /* ════════════════════════════════════════
     MANAGEMENT VIEW
     KPI completion → pipeline stat cards → leaderboard → sources → today (compact)
     ════════════════════════════════════════ */
  if (isManagement) {
    return (
      <DashboardScrollContainer className="space-y-5">
        <AlertPanel />
        {Header}

        {/* L1: KPI completion — BIG numbers with progress bars */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: t("kpi.signing"), pct: signingPct, actual: signingActual, target: signingTarget, sub: t("kpi.contracts").replace("{n}", String(contractCount)) },
            { label: t("kpi.collection"), pct: collectionPct, actual: collectionActual, target: collectionTarget, sub: t("dashboard.ratePct").replace("{n}", String(financeStats.totalContractValue > 0 ? Math.round((financeStats.received / financeStats.totalContractValue) * 100) : 0)) },
            { label: t("payment.overdue"), pct: null, actual: financeStats.overdue, target: 0, sub: financeStats.overdue > 0 ? `⚠ ${t("dashboard.needsFollowup")}` : t("dashboard.noTargetSet"), alert: financeStats.overdue > 0 },
            { label: t("dashboard.dueNextWeek"), pct: null, actual: financeStats.dueNextWeek, target: 0, sub: financeStats.dueNextWeek > 0 ? t("dashboard.nPending").replace("{n}", String(financeStats.dueNextWeek)) : t("dashboard.noTargetSet") },
          ].map(card => (
            <div key={card.label}
              className={cn("p-4 rounded-xl border bg-card/50", card.alert ? "border-red-500/30" : "border-border/50")}
            >
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 font-medium">{card.label}</p>
              {card.pct !== null ? (
                <>
                  <p className={cn("text-[36px] font-bold leading-none", pctColor(card.pct))}>
                    {card.pct !== null ? `${card.pct}%` : "—"}
                  </p>
                  <div className="h-2 bg-muted rounded-full mt-2 mb-1 overflow-hidden">
                    <div className={cn("h-full rounded-full transition-all", barColor(card.pct))}
                      style={{ width: `${Math.min(card.pct ?? 0, 100)}%` }} />
                  </div>
                </>
              ) : (
                <p className={cn("text-[36px] font-bold leading-none", card.alert ? "text-red-400" : "text-foreground")}>
                  {fmtAED(card.actual)}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {card.pct !== null ? `${fmtAED(card.actual)} / ${fmtAED(card.target)} · ${card.sub}` : card.sub}
              </p>
            </div>
          ))}
        </div>

        {/* L2: Pipeline stat cards — compact */}
        {KpiStatCards}

        {/* L3: Sales Leaderboard */}
        {salesLeaderboard.length > 0 && (
          <div>
            <SectionHeader title={t("dashboard.salesLeaderboard")} subtitle={`(${period})`} />
            <div className="space-y-2">
              {salesLeaderboard.slice(0, 5).map((s) => (
                <div key={s.id}
                  className="p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 transition-all cursor-pointer"
                  onClick={() => router.push(`/leads?assigned_to=${s.id}`)}
                >
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium w-24 shrink-0 truncate">{s.name}</span>
                    <div className="flex-1 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {t("dashboard.won")} {fmtAED(s.wonValue)} · {s.wonCount} {t("dashboard.deals")} · {s.totalLeads} {t("leads.title").toLowerCase()} · {s.conversionRate}% {t("dashboard.kpiConv")}
                        </span>
                        {s.targetAmount > 0 ? (
                          <span className={cn("font-medium", s.completionRate <= 0 ? "text-muted-foreground" : s.completionRate >= expectedPct ? "text-emerald-400" : "text-amber-400")}>
                            {s.completionRate}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                      {s.targetAmount > 0 && (
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className={cn("h-full rounded-full transition-all",
                            s.completionRate <= 0 ? "bg-muted" : s.completionRate >= expectedPct ? "bg-emerald-500" : "bg-amber-500"
                          )} style={{ width: `${Math.min(s.completionRate, 100)}%` }} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* L3b: Team Lead Ownership */}
        <div>
          <SectionHeader title={language === "zh" ? "团队 Lead 归属" : "Team Lead Ownership"} />
          <div className="overflow-x-auto">
            {teamOwnership.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {language === "zh" ? "暂无数据" : "No data yet"}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground text-xs">
                    <th className="text-left py-2 pr-3">{language === "zh" ? "成员" : "Member"}</th>
                    <th className="text-right py-2 px-2">{language === "zh" ? "角色" : "Role"}</th>
                    <th className="text-right py-2 px-2">{language === "zh" ? "负责" : "Assigned"}</th>
                    <th className="text-right py-2 px-2">{language === "zh" ? "导入" : "Imported"}</th>
                    <th className="text-right py-2 px-2">{language === "zh" ? "活跃" : "Active"}</th>
                    <th className="text-right py-2 px-2">{language === "zh" ? "成交" : "Won"}</th>
                    <th className="text-right py-2 pl-2">{language === "zh" ? "流失" : "Lost"}</th>
                  </tr>
                </thead>
                <tbody>
                  {teamOwnership.map((u: any) => (
                    <tr key={u.user_id} className="border-b border-border/30 hover:bg-accent/30 cursor-pointer"
                      onClick={() => router.push(`/leads?assigned_to=${u.user_id}`)}>
                      <td className="py-2 pr-3 font-medium truncate max-w-[120px]">{u.full_name}</td>
                      <td className="py-2 px-2 text-right text-xs text-muted-foreground">{u.role}</td>
                      <td className="py-2 px-2 text-right">{u.assigned_leads}</td>
                      <td className="py-2 px-2 text-right">{u.imported_leads}</td>
                      <td className="py-2 px-2 text-right">{u.active_leads}</td>
                      <td className="py-2 px-2 text-right text-emerald-400">{u.won_leads}</td>
                      <td className="py-2 pl-2 text-right text-red-400">{u.lost_leads}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* L4: Lead Sources */}
        {sourceBreakdown.length > 0 && (
          <div>
            <SectionHeader title={t("dashboard.leadSources")} subtitle={`(${sourceBreakdown.reduce((a, b) => a + b.total, 0)} ${t("dashboard.leads")})`} />
            <div className="space-y-2">
              {sourceBreakdown.map((s) => {
                const pct = Math.round((s.total / maxSourceTotal) * 100);
                const convRate = s.total > 0 ? Math.round((s.won / s.total) * 100) : 0;
                return (
                  <div key={s.source} className="p-3 rounded-xl border border-border/50 bg-card/50 group hover:border-copper-400/30 transition-all">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium">{s.label}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {s.total} {t("leads.title").toLowerCase()} · {s.won} {t("dashboard.won")} · {convRate}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={cn("h-full rounded-full transition-all", convRate >= 30 ? "bg-emerald-500" : convRate >= 10 ? "bg-amber-500" : "bg-muted-foreground/40")}
                        style={{ width: `${Math.max(pct, 6)}%` }} />
                    </div>
                    {s.value > 0 && (
                      <p className="text-[10px] text-muted-foreground mt-1">{fmtAED(s.value)} {t("dashboard.pipelineValue").toLowerCase()}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* L5: Today's Actions — compressed, small, at very bottom */}
        {topActions.length > 0 && (
          <div>
            <SectionHeader title={t("dashboard.todaysActions")} subtitle={t("dashboard.nItems").replace("{n}", String(topActions.length))} />
            {TodayActions}
          </div>
        )}
      </DashboardScrollContainer>
    );
  }

  /* ════════════════════════════════════════
     SALES VIEW
     Today's actions → my KPI → my pipeline → sources
     ════════════════════════════════════════ */
  return (
    <DashboardScrollContainer className="space-y-5">
      <AlertPanel />
      {Header}

      {/* L1: Today's Actions — THE hero section for sales */}
      <div>
        <SectionHeader title={t("dashboard.todaysActions")} subtitle={t("dashboard.whatToDoToday")} />
        {followupLoading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">{t("dashboard.loadingActions")}</div>
        ) : (
          TodayActions
        )}
      </div>

      {/* L2: My KPI progress */}
      <div>
        <SectionHeader title={t("dashboard.myProgress")} subtitle={period} />
        {signingTarget === 0 && collectionTarget === 0 && (
          <div className="mb-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">
            {t("dashboard.noKpiTarget")}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border border-border/50 bg-card/50">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 font-medium">{t("kpi.signing")}</p>
            <p className={cn("text-[36px] font-bold leading-none", pctColor(signingPct))}>
              {signingPct !== null ? `${signingPct}%` : "—"}
            </p>
            <div className="h-2 bg-muted rounded-full mt-2 mb-1 overflow-hidden">
              <div className={cn("h-full rounded-full transition-all", barColor(signingPct))}
                style={{ width: `${Math.min(signingPct ?? 0, 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{fmtAED(signingActual)} / {fmtAED(signingTarget)} · {t("kpi.contracts").replace("{n}", String(contractCount))}</p>
          </div>
          <div className="p-4 rounded-xl border border-border/50 bg-card/50">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 font-medium">{t("kpi.collection")}</p>
            <p className={cn("text-[36px] font-bold leading-none", pctColor(collectionPct))}>
              {collectionPct !== null ? `${collectionPct}%` : "—"}
            </p>
            <div className="h-2 bg-muted rounded-full mt-2 mb-1 overflow-hidden">
              <div className={cn("h-full rounded-full transition-all", barColor(collectionPct))}
                style={{ width: `${Math.min(collectionPct ?? 0, 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{fmtAED(collectionActual)} / {fmtAED(collectionTarget)}</p>
          </div>
        </div>
      </div>

      {/* L3: My pipeline stat cards */}
      {KpiStatCards}

      {/* L4: Lead Sources */}
      {sourceBreakdown.length > 0 && (
        <div>
            <SectionHeader title={t("dashboard.leadSources")} subtitle={`(${sourceBreakdown.reduce((a, b) => a + b.total, 0)} ${t("dashboard.leads")})`} />
          <div className="space-y-2">
            {sourceBreakdown.map((s) => {
              const pct = Math.round((s.total / maxSourceTotal) * 100);
              const convRate = s.total > 0 ? Math.round((s.won / s.total) * 100) : 0;
              return (
                <div key={s.source} className="p-3 rounded-xl border border-border/50 bg-card/50">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium">{s.label}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {s.total} leads · {s.won} won · {convRate}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className={cn("h-full rounded-full transition-all", convRate >= 30 ? "bg-emerald-500" : convRate >= 10 ? "bg-amber-500" : "bg-muted-foreground/40")}
                      style={{ width: `${Math.max(pct, 6)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DashboardScrollContainer>
  );
}
