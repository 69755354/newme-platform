// RBAC: user (authenticated)
// GET /api/dashboard/summary — Aggregated dashboard data with 30s cache
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { getCached, setCache } from "@/lib/api-cache";

/* ─── Types ─── */
interface TopAction {
  type: string;
  title: string;
  subtitle: string;
  link: string;
  priority: "high" | "medium" | "low";
  customerName: string;
  value: number;
  reason: string;
  phone: string | null;
  leadId: string;
}

export async function GET(request: Request) {
  const supabase = await createServerSupabase();

  // 1. Auth
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Profile → role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 403 });
  }

  const role: string = profile.role;
  const userId: string = user.id;
  const isManagement = ["admin", "boss", "operator"].includes(role);
  const isSales = role === "sales";

  // Month from query param (?period= legacy support removed in P3_9)
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month");
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json(
      { error: "Invalid month format (YYYY-MM required)" },
      { status: 400 }
    );
  }

  let monthStart: string | null = null;
  let monthEnd: string | null = null;
  if (month) {
    const [year, monthNumber] = month.split("-").map(Number);
    monthStart = new Date(year, monthNumber - 1, 1).toISOString();
    monthEnd = new Date(year, monthNumber, 1).toISOString();
  }

  // ── Cache key ──
  const cacheKey = `dashboard-summary:${role}:${userId}:${month || ""}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  // ── 3. Sales users ──
  const { data: salesUsers } = await supabase
    .from("profiles")
    .select("id,email,role,full_name")
    .in("role", ["admin", "sales", "operator", "boss"]);

  // ── 4a. Leads (no dependency) ──
  let leadsQuery = supabase.from("leads").select("*");
  if (isSales && userId) {
    leadsQuery = leadsQuery.eq("assigned_to", userId);
  }
  const leadsPromise = leadsQuery.order("updated_at", { ascending: false }).limit(500);

  // ── 4b. Contracts (no dependency) ──
  let contractQuery = supabase
    .from("contracts")
    .select("id,contract_amount,status,created_at");
  if (isSales && userId) {
    contractQuery = contractQuery.eq("sales_id", userId);
  }
  const contractsPromise = contractQuery;

  // ── 4c. KPI targets (no dependency) ──
  const kpiPromise = month
    ? supabase.from("kpi_targets").select("*").eq("period", month)
    : Promise.resolve({ data: [], error: null });

  const periodLeadsPromise = monthStart && monthEnd
    ? (() => {
        let q = supabase
          .from("leads")
          .select("quality,source")
          .gte("created_at", monthStart)
          .lt("created_at", monthEnd);
        if (isSales && userId) q = q.eq("assigned_to", userId);
        return q;
      })()
    : Promise.resolve({ data: [], error: null });

  const periodContractsPromise = monthStart && monthEnd
    ? (() => {
        let q = supabase
          .from("contracts")
          .select("contract_amount")
          .gte("created_at", monthStart)
          .lt("created_at", monthEnd);
        if (isSales && userId) q = q.eq("sales_id", userId);
        return q;
      })()
    : Promise.resolve({ data: [], error: null });

  const periodWonPromise = monthStart && monthEnd
    ? (() => {
        let q = supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("final_status", "won")
          .gte("won_at", monthStart)
          .lt("won_at", monthEnd);
        if (isSales && userId) q = q.eq("assigned_to", userId);
        return q;
      })()
    : Promise.resolve({ count: 0, error: null });

  const stageChangesPromise = monthStart && monthEnd
    ? supabase
        .from("business_events")
        .select("lead_id,event_data,created_at")
        .eq("event_type", "stage_change")
        .gte("created_at", monthStart)
        .lt("created_at", monthEnd)
        .order("created_at", { ascending: true })
    : Promise.resolve({ data: [], error: null });

  // Run first batch in parallel (no contract-id dependency)
  const [
    { data: leads, error: leadsErr },
    { data: contracts, error: cErr },
    { data: kpiTargets },
    { data: periodLeadsRaw, error: periodLeadsErr },
    { data: periodContractsRaw, error: periodContractsErr },
    { count: periodWonCount, error: periodWonErr },
    { data: stageChangesRaw, error: stageChangesErr },
  ] = await Promise.all([
    leadsPromise,
    contractsPromise,
    kpiPromise,
    periodLeadsPromise,
    periodContractsPromise,
    periodWonPromise,
    stageChangesPromise,
  ]);

  if (leadsErr) console.error("leads fetch failed:", leadsErr);
  if (cErr) console.error("contracts fetch failed:", cErr);
  if (periodLeadsErr) console.error("period leads fetch failed:", periodLeadsErr);
  if (periodContractsErr) console.error("period contracts fetch failed:", periodContractsErr);
  if (periodWonErr) console.error("period won leads fetch failed:", periodWonErr);
  if (stageChangesErr) console.error("stage changes fetch failed:", stageChangesErr);

  const leadsData = (leads || []) as any[];
  const contractsData = (contracts || []) as any[];

  // ── Compute contract IDs & active contracts ──
  const contractIds = contractsData.map((c: any) => c.id);

  // ── Date boundaries ──
  const nowISO = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekStr = nextWeek.toISOString().split("T")[0];

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const cutoff48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  // ── 4d–m. Second batch: everything with contract-id or independent ──
  const buildPaymentsQuery = () => {
    if (isSales && contractIds.length === 0) return Promise.resolve({ data: [], error: null });
    let q = supabase.from("payments").select("amount,confirmed,payment_date");
    if (isSales && userId) q = q.in("contract_id", contractIds);
    return q;
  };

  const buildPeriodPaymentsQuery = () => {
    if (!monthStart || !monthEnd || (isSales && contractIds.length === 0)) {
      return Promise.resolve({ data: [], error: null });
    }
    let q = supabase
      .from("payments")
      .select("amount")
      .eq("confirmed", true)
      .gte("payment_date", monthStart)
      .lt("payment_date", monthEnd);
    if (isSales && userId) q = q.in("contract_id", contractIds);
    return q;
  };

  const buildOverdueQuery = () => {
    if (isSales && contractIds.length === 0) return Promise.resolve({ data: [], error: null });
    let q = supabase
      .from("installment_plans")
      .select("amount,due_date,status,paid_amount")
      .lt("due_date", nowISO)
      .neq("status", "paid");
    if (isSales && userId) q = q.in("contract_id", contractIds);
    return q;
  };

  const buildDueQuery = () => {
    if (isSales && contractIds.length === 0) return Promise.resolve({ data: [], error: null });
    let q = supabase
      .from("installment_plans")
      .select("amount,due_date,status,paid_amount")
      .gte("due_date", nowISO)
      .lte("due_date", nextWeekStr)
      .eq("status", "pending");
    if (isSales && userId) q = q.in("contract_id", contractIds);
    return q;
  };

  const buildRiskPoolQuery = async (): Promise<number> => {
    try {
      const { count } = await supabase
        .from("v_risk_pool")
        .select("*", { count: "exact", head: true });
      return count || 0;
    } catch {
      let riskQ = supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .is("completed_at", null)
        .lt("due_at", new Date().toISOString());
      if (isSales && userId) {
        riskQ = riskQ.eq("assignee_id", userId);
      }
      const { count } = await riskQ;
      return count || 0;
    }
  };

  const buildTodayFollowupsQuery = () => {
    let q = supabase
      .from("tasks")
      .select("lead_id, due_at, leads!inner(*)")
      .is("completed_at", null)
      .gte("due_at", todayStart.toISOString())
      .lt("due_at", tomorrowStart.toISOString());
    if (isSales && userId) {
      q = q.eq("assignee_id", userId);
    }
    return q.order("due_at");
  };

  const buildOverdueFollowupsQuery = () => {
    let q = supabase
      .from("tasks")
      .select(
        "lead_id, due_at, leads!inner(id, customer_name, quotation_value, last_contact_date, phone, final_status)"
      )
      .is("completed_at", null)
      .lt("due_at", new Date().toISOString())
      .order("due_at", { ascending: true })
      .limit(5);
    if (isSales && userId) q = q.eq("assignee_id", userId);
    return q;
  };

  const buildHotLeadsQuery = () => {
    let q = supabase
      .from("leads")
      .select("id, customer_name, quotation_value, win_probability, stage, phone")
      .eq("lead_status", "hot")
      .is("final_status", null)
      .order("quotation_value", { ascending: false })
      .limit(3);
    if (isSales && userId) q = q.eq("assigned_to", userId);
    return q;
  };

  const buildDraftQuotesQuery = () => {
    let q = supabase
      .from("quotations")
      .select("*, leads!inner(customer_name, quotation_value, id, phone)")
      .eq("status", "draft")
      .order("total_amount", { ascending: false })
      .limit(3);
    if (isSales && userId) q = q.eq("created_by", userId);
    return q;
  };

  const buildStaleLeadsQuery = () => {
    let q = supabase
      .from("leads")
      .select("id, customer_name, quotation_value, last_contact_date, stage, phone")
      .is("final_status", null)
      .or(`last_contact_date.lt.${cutoff48h},last_contact_date.is.null`)
      .order("quotation_value", { ascending: false })
      .limit(3);
    if (isSales && userId) q = q.eq("assigned_to", userId);
    return q;
  };

  const buildOverdueWorkflowQuery = () => {
    let q = supabase
      .from("lead_workflow_stages")
      .select("*, leads!inner(customer_name, quotation_value, phone)")
      .eq("status", "in_progress")
      .lt("deadline_at", new Date().toISOString())
      .order("deadline_at", { ascending: true })
      .limit(3);
    if (isSales && userId) {
      q = q.eq("assigned_to", userId);
    }
    return q;
  };

  const [
    { data: payments, error: pErr },
    { data: overduePlans, error: oErr },
    { data: duePlans, error: dErr },
    riskPoolCount,
    { data: todayFollowupsRaw },
    { data: overdueFollowups },
    { data: hotLeads },
    { data: draftQuotes },
    { data: staleLeads },
    { data: overdueWorkflow },
    { data: periodPaymentsRaw, error: periodPaymentsErr },
  ] = await Promise.all([
    buildPaymentsQuery(),
    buildOverdueQuery(),
    buildDueQuery(),
    buildRiskPoolQuery(),
    buildTodayFollowupsQuery(),
    buildOverdueFollowupsQuery(),
    buildHotLeadsQuery(),
    buildDraftQuotesQuery(),
    buildStaleLeadsQuery(),
    buildOverdueWorkflowQuery(),
    buildPeriodPaymentsQuery(),
  ]);

  if (pErr) console.error("payments fetch failed:", pErr);
  if (oErr) console.error("overdue plans fetch failed:", oErr);
  if (dErr) console.error("due plans fetch failed:", dErr);
  if (periodPaymentsErr) console.error("period payments fetch failed:", periodPaymentsErr);

  // ── 5. Compute financeStats ──
  const activeContracts = contractsData.filter(
    (c: any) => c.status !== "terminated"
  );
  const totalContractValue = activeContracts.reduce(
    (sum: number, c: any) => sum + (c.contract_amount || 0),
    0
  );

  const confirmedPayments = ((payments as any[]) || []).filter(
    (p: any) => p.confirmed === true
  );
  const received = confirmedPayments.reduce(
    (sum: number, p: any) => sum + (p.amount || 0),
    0
  );
  const outstanding = totalContractValue - received;

  const overdueAmount = ((overduePlans as any[]) || []).reduce(
    (sum: number, p: any) => sum + (p.amount || 0),
    0
  );
  const dueNextWeekAmount = ((duePlans as any[]) || []).reduce(
    (sum: number, p: any) => sum + (p.amount || 0),
    0
  );

  const periodContractAmount = ((periodContractsRaw as any[]) || []).reduce(
    (sum: number, contract: any) => sum + (contract.contract_amount || 0),
    0
  );
  const periodPaymentAmount = ((periodPaymentsRaw as any[]) || []).reduce(
    (sum: number, payment: any) => sum + (payment.amount || 0),
    0
  );

  const finance = {
    totalContractValue: Math.round(totalContractValue),
    received: Math.round(received),
    outstanding: Math.round(outstanding),
    overdue: Math.round(overdueAmount),
    dueNextWeek: Math.round(dueNextWeekAmount),
    contractCount: activeContracts.length,
    ...(month
      ? {
          contractAmount: periodContractAmount,
          paymentAmount: periodPaymentAmount,
          wonCount: periodWonCount || 0,
        }
      : {}),
  };

  const groupPeriodLeads = (field: "quality" | "source") =>
    ((periodLeadsRaw as any[]) || []).reduce<Record<string, number>>(
      (groups, lead) => {
        const key = String(lead[field] ?? "unknown");
        groups[key] = (groups[key] || 0) + 1;
        return groups;
      },
      {}
    );

  const periodLeads = {
    count: ((periodLeadsRaw as any[]) || []).length,
    byQuality: groupPeriodLeads("quality"),
    bySource: groupPeriodLeads("source"),
  };

  // ── 6. Compute todayFollowups ──
  const todayFollowups = ((todayFollowupsRaw as any[]) || [])
    .flatMap((task: any) => {
      const lead = Array.isArray(task.leads) ? task.leads[0] : task.leads;
      return lead && !lead.final_status ? [lead] : [];
    });

  // ── 7. Compute topActions ──
  const actions: TopAction[] = [];

  // 1. Overdue followups
  ((overdueFollowups as any[]) || []).forEach((task: any) => {
    const l = Array.isArray(task.leads) ? task.leads[0] : task.leads;
    if (!l || l.final_status) return;
    const daysLate = Math.ceil(
      (Date.now() - new Date(task.due_at).getTime()) / 86400000
    );
    actions.push({
      type: "overdue_followup",
      title: l.customer_name || "Unnamed",
      subtitle: `${l.customer_name || "Unnamed"} · Overdue ${daysLate}d`,
      link: `/leads/${l.id}`,
      priority: daysLate >= 3 ? "high" : "medium",
      customerName: l.customer_name || "Unnamed",
      value: l.quotation_value || 0,
      reason: `Overdue follow-up (${daysLate}d)`,
      phone: l.phone || null,
      leadId: l.id,
    });
  });

  // 2. Hot leads
  ((hotLeads as any[]) || []).forEach((l: any) => {
    actions.push({
      type: "hot_lead",
      title: l.customer_name || "Unnamed",
      subtitle: `${l.customer_name || "Unnamed"} · Win prob ${l.win_probability || 0}%`,
      link: `/leads/${l.id}`,
      priority: (l.win_probability || 0) >= 70 ? "high" : "medium",
      customerName: l.customer_name || "Unnamed",
      value: l.quotation_value || 0,
      reason: "Hot lead priority",
      phone: l.phone || null,
      leadId: l.id,
    });
  });

  // 3. Draft quotes
  ((draftQuotes as any[]) || []).forEach((q: any) => {
    actions.push({
      type: "quote_draft",
      title: q.leads?.customer_name || "Unnamed",
      subtitle: `${q.leads?.customer_name || "Unnamed"} · ${q.quote_no || "Draft quote"}`,
      link: `/quotes`,
      priority: "medium",
      customerName: q.leads?.customer_name || "Unnamed",
      value: q.total_amount || 0,
      reason: "Draft quote pending",
      phone: q.leads?.phone || null,
      leadId: q.leads?.id || "",
    });
  });

  // 4. Stale leads
  ((staleLeads as any[]) || []).forEach((l: any) => {
    const daysInactive = l.last_contact_date
      ? Math.ceil(
          (Date.now() - new Date(l.last_contact_date).getTime()) / 86400000
        )
      : 99;
    actions.push({
      type: "stale_lead",
      title: l.customer_name || "Unnamed",
      subtitle: `${l.customer_name || "Unnamed"} · Inactive ${daysInactive}d`,
      link: `/leads/${l.id}`,
      priority: daysInactive > 7 ? "high" : "medium",
      customerName: l.customer_name || "Unnamed",
      value: l.quotation_value || 0,
      reason: `No reply (${daysInactive}d)`,
      phone: l.phone || null,
      leadId: l.id,
    });
  });

  // 5. Overdue workflow stages
  ((overdueWorkflow as any[]) || []).forEach((w: any) => {
    const leadName = w.leads?.customer_name || "Unnamed";
    actions.push({
      type: "workflow_overdue",
      title: leadName,
      subtitle: `${leadName} · Stage overdue: ${w.stage_key || "unknown"}`,
      link: `/leads/${w.lead_id}`,
      priority: "high",
      customerName: leadName,
      value: w.leads?.quotation_value || 0,
      reason: "Workflow stage overdue",
      phone: w.leads?.phone || null,
      leadId: w.lead_id,
    });
  });

  // Sort by priority score and deduplicate by link
  const priorityScore = (a: TopAction): number => {
    const urgencyMult = a.priority === "high" ? 3 : a.priority === "medium" ? 2 : 1;
    return a.value * urgencyMult;
  };
  const seenLinks = new Set<string>();
  const sorted = actions
    .sort((a, b) => priorityScore(b) - priorityScore(a))
    .filter((a) => {
      if (seenLinks.has(a.link)) return false;
      seenLinks.add(a.link);
      return true;
    });

  // ── 8. Build response ──
  const result = {
    profile: { userId, role },
    salesUsers: salesUsers || [],
    leads: leadsData,
    finance,
    kpiTargets: kpiTargets || [],
    riskPoolCount,
    todayFollowups,
    topActions: sorted.slice(0, 5),
    // Include raw data needed for UI i18n
    overdueFollowups: overdueFollowups || [],
    ...(month
      ? {
          periodLeads,
          stageChanges: stageChangesRaw || [],
        }
      : {}),
  };

  // ── Cache write (30s) ──
  setCache(cacheKey, result, 30);

  return NextResponse.json(result);
}
