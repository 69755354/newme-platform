// RBAC: user (authenticated)
// GET /api/dashboard/summary — Aggregated dashboard data
//
// Round-4 finding R5. This route reads payments, installment_plans and kpi_targets,
// and it did both of the things that finding is about:
//
//   * `received`, and through it `outstanding` and the collection rate, filtered on
//     `p.confirmed === true` alone. Every derived total in the database counts
//     `confirmed = true and voided_at is null` — see src/lib/payment-state.mjs — so
//     this was a second, looser definition of cash sitting next to the ledger's.
//   * the whole response was cached in src/lib/api-cache.ts for 30 seconds under
//     `dashboard-summary:${role}:${userId}:${month}`, a Map with no eviction path
//     that `revalidatePath()` cannot reach. Confirm a payment and the dashboard kept
//     reporting the old received/outstanding figures and the old KPI actuals for the
//     rest of the TTL, while the payments page reported the new ones.
//
// So: no module cache, force-dynamic and no-store, and one predicate.
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";
import { countsAsCash } from "@/lib/payment-state.mjs";
import {
  addDaysToDateKey,
  dubaiDateKey,
  dubaiDayBounds,
  dubaiMonthBounds,
  inBounds,
  isMonthKey,
} from "@/lib/dubai-time.mjs";
import { fetchAllRows, fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import {
  LEAD_METRIC_COLUMNS,
  isCountedLead,
  overdueDays,
  summarizeLeads,
  type MetricLead,
  EXCLUDE_SYNTHETIC_QA_FILTER,
} from "@/lib/lead-metrics.mjs";

export const dynamic = "force-dynamic";

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
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

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

  if (!profile?.role) {
    return NextResponse.json({ error: "Profile not found" }, { status: 403 });
  }

  const role = profile.role;
  const userId: string = user.id;
  const isManagement = ["admin", "boss", "operator"].includes(role);
  const isSales = role === "sales";

  // Month from query param (?period= legacy support removed in P3_9). Every
  // period below is a Dubai calendar period (src/lib/dubai-time.mjs): the host
  // runs in Asia/Shanghai, so `new Date(y, m, 1)` started each month at 20:00
  // Dubai on the last day of the previous one.
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month");
  if (month !== null && !isMonthKey(month)) {
    return NextResponse.json(
      { error: "Invalid month format (YYYY-MM required)" },
      { status: 400 }
    );
  }

  const period = month ? dubaiMonthBounds(month) : null;

  // ── Date boundaries (Dubai) ──
  const nowDate = new Date();
  const nowISO = dubaiDateKey(nowDate) as string; // YYYY-MM-DD, Dubai
  const nextWeekStr = addDaysToDateKey(nowISO, 7);
  const { start: todayStart, end: tomorrowStart } = dubaiDayBounds(nowDate);
  const cutoff48h = new Date(nowDate.getTime() - 48 * 3600 * 1000).toISOString();

  // ── 3. Sales users ──
  const salesUsersPromise = isManagement
    ? supabase
        .from("profiles")
        .select("id,email,role,full_name")
        .in("role", ["admin", "sales", "operator", "boss"])
    : Promise.resolve({ data: [] as any[], error: null });

  // ── 4a. Leads — every counted (non-archived) lead, narrow columns, paged ──
  // The page used to receive `select("*")` of the 500 most recently updated rows
  // (archived included) and count them in the browser; past 500 leads the numbers
  // silently stopped growing and the payload was the slowest part of the page.
  // Now the counting happens here, once, with src/lib/lead-metrics.mjs.
  const leadsPromise = fetchCountedLeads(
    supabase,
    LEAD_METRIC_COLUMNS,
    { assignedTo: isSales ? userId : null },
  );

  // Money queries read every row (paged: PostgREST would otherwise stop at 1000
  // rows without saying so) and are scoped for a sales caller by joining to the
  // contract, so none of them waits for another query first.
  const paged = (build: (withCount: boolean) => any) =>
    fetchAllRows((from, to, withCount) => build(withCount).order("id", { ascending: true }).range(from, to));

  // ── 4b. Contracts ──
  const contractsPromise = paged((withCount) => {
    let q = supabase
      .from("contracts")
      .select("id,contract_amount,status,created_at", withCount ? { count: "exact" } : undefined);
    if (isSales && userId) q = q.eq("sales_id", userId);
    return q;
  });

  // ── 4c. KPI targets ──
  const kpiPromise = month
    ? supabase.from("kpi_targets").select("*").eq("period", month)
    : Promise.resolve({ data: [], error: null });

  // payments.payment_date is a DATE: compare it with Dubai calendar dates, not
  // with the UTC instants of the month bounds (a date column cast from
  // "2026-10-31T20:00:00Z" is 31 October, which put the last day of the previous
  // month into every month's collection figure).
  const periodStartDate = period ? (dubaiDateKey(period.start) as string) : null;
  const periodEndDate = period ? (dubaiDateKey(period.end) as string) : null;

  const paymentsPromise = paged((withCount) => {
    let q = supabase
      .from("payments")
      .select(
        isSales ? "id,amount,confirmed,voided_at,payment_date,contracts!inner(sales_id)" : "id,amount,confirmed,voided_at,payment_date",
        withCount ? { count: "exact" } : undefined,
      )
      .eq("confirmed", true)
      .is("voided_at", null);
    if (isSales && userId) q = q.eq("contracts.sales_id", userId);
    return q;
  });

  const periodPaymentsPromise = periodStartDate && periodEndDate
    ? paged((withCount) => {
        let q = supabase
          .from("payments")
          .select(
            isSales ? "id,amount,contracts!inner(sales_id)" : "id,amount",
            withCount ? { count: "exact" } : undefined,
          )
          // Both halves of the ledger predicate. This total is compared against
          // kpi_targets.actual_amount, which confirm_payment() and void_payment()
          // maintain from `confirmed = true and voided_at is null`.
          .eq("confirmed", true)
          .is("voided_at", null)
          .gte("payment_date", periodStartDate)
          .lt("payment_date", periodEndDate);
        if (isSales && userId) q = q.eq("contracts.sales_id", userId);
        return q;
      })
    : Promise.resolve({ data: [], error: null });

  const installmentsPromise = (kind: "overdue" | "due") =>
    paged((withCount) => {
      let q = supabase
        .from("installment_plans")
        .select(
          isSales ? "id,amount,due_date,status,paid_amount,contracts!inner(sales_id)" : "id,amount,due_date,status,paid_amount",
          withCount ? { count: "exact" } : undefined,
        );
      q = kind === "overdue"
        ? q.lt("due_date", nowISO).neq("status", "paid")
        : q.gte("due_date", nowISO).lte("due_date", nextWeekStr).eq("status", "pending");
      if (isSales && userId) q = q.eq("contracts.sales_id", userId);
      return q;
    });

  const buildRiskPoolQuery = async (): Promise<number> => {
    if (isSales && userId) {
      const { count } = await supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("assignee_id", userId)
        .eq("status", "pending")
        .lt("due_at", new Date().toISOString());
      return count || 0;
    }
    try {
      const { count } = await supabase
        .from("v_risk_pool")
        .select("*", { count: "exact", head: true });
      return count || 0;
    } catch {
      const { count } = await supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .lt("due_at", new Date().toISOString());
      return count || 0;
    }
  };

  const buildTodayFollowupsQuery = () => {
    let q = supabase
      .from("tasks")
      .select("lead_id, due_at, leads!inner(id, customer_name, phone, quotation_value, final_status, archived)")
      .eq("status", "pending")
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
      .eq("status", "pending")
      .eq("leads.archived", false)
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
      .eq("archived", false)
      .or(EXCLUDE_SYNTHETIC_QA_FILTER)
      .is("final_status", null)
      .order("quotation_value", { ascending: false })
      .limit(3);
    if (isSales && userId) q = q.eq("assigned_to", userId);
    return q;
  };

  const buildDraftQuotesQuery = () => {
    let q = supabase
      .from("quotations")
      .select("quote_no, total_amount, leads!inner(customer_name, quotation_value, id, phone)")
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
      .eq("archived", false)
      .or(EXCLUDE_SYNTHETIC_QA_FILTER)
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
      .select("stage_key, lead_id, deadline_at, leads!inner(customer_name, quotation_value, phone)")
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
    leadsResult,
    { data: salesUsers },
    contractsResult,
    { data: kpiTargets },
    paymentsResult,
    overdueResult,
    dueResult,
    riskPoolCount,
    { data: todayFollowupsRaw },
    { data: overdueFollowups },
    { data: hotLeads },
    { data: draftQuotes },
    { data: staleLeads },
    { data: overdueWorkflow },
    periodPaymentsResult,
  ] = await Promise.all([
    leadsPromise,
    salesUsersPromise,
    contractsPromise,
    kpiPromise,
    paymentsPromise,
    installmentsPromise("overdue"),
    installmentsPromise("due"),
    buildRiskPoolQuery(),
    buildTodayFollowupsQuery(),
    buildOverdueFollowupsQuery(),
    buildHotLeadsQuery(),
    buildDraftQuotesQuery(),
    buildStaleLeadsQuery(),
    buildOverdueWorkflowQuery(),
    periodPaymentsPromise,
  ]);

  // A failed read must not turn into a quiet zero on the boss's dashboard.
  for (const [label, result] of [
    ["leads", leadsResult],
    ["contracts", contractsResult],
    ["payments", paymentsResult],
    ["overdue plans", overdueResult],
    ["due plans", dueResult],
    ["period payments", periodPaymentsResult],
  ] as const) {
    if (result.error) {
      console.error(`dashboard summary: ${label} fetch failed:`, result.error);
      return applyPrivateNoStore(NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 }));
    }
  }

  const leadsData = leadsResult.data as unknown as MetricLead[];
  const contractsData = contractsResult.data as any[];
  const payments = paymentsResult.data as any[];
  const overduePlans = overdueResult.data as any[];
  const duePlans = dueResult.data as any[];
  const periodPaymentsRaw = periodPaymentsResult.data as any[];

  // One definition of every lead figure on the page (src/lib/lead-metrics.mjs).
  const leadStats = summarizeLeads(leadsData, { period, now: nowDate });

  // ── 5. Compute financeStats ──
  const activeContracts = contractsData.filter(
    (c: any) => c.status !== "terminated"
  );
  const totalContractValue = activeContracts.reduce(
    (sum: number, c: any) => sum + (c.contract_amount || 0),
    0
  );

  const confirmedPayments = (payments || []).filter((p: any) =>
    countsAsCash(p)
  );
  const received = confirmedPayments.reduce(
    (sum: number, p: any) => sum + (p.amount || 0),
    0
  );
  const outstanding = totalContractValue - received;

  const overdueAmount = (overduePlans || []).reduce(
    (sum: number, p: any) => sum + (p.amount || 0),
    0
  );
  const dueNextWeekAmount = (duePlans || []).reduce(
    (sum: number, p: any) => sum + (p.amount || 0),
    0
  );

  const periodPaymentAmount = (periodPaymentsRaw || []).reduce(
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
          // "Signed" this month = what was won this month (leads.won_at, Dubai
          // month): the same figure a sales rep sees for themselves. It is NOT the
          // sum of contracts created in the month: a converted quote creates a
          // draft contract that may still be pending, rejected or terminated.
          signedAmount: leadStats.periodWonValue,
          paymentAmount: periodPaymentAmount,
          // Same definition as leadStats.periodWonCount: counted leads won in the
          // Dubai month by won_at (quote-conversion wins included).
          wonCount: leadStats.periodWonCount,
        }
      : {}),
  };

  // Leads created in the Dubai month, from the rows already read above.
  const periodLeadRows = period
    ? leadsData.filter((lead) => isCountedLead(lead) && inBounds(lead.created_at, period))
    : [];
  const groupPeriodLeads = (field: "quality" | "source") =>
    periodLeadRows.reduce<Record<string, number>>((groups, lead) => {
      const key = String((lead as any)[field] ?? "unknown");
      groups[key] = (groups[key] || 0) + 1;
      return groups;
    }, {});

  const periodLeads = {
    count: periodLeadRows.length,
    byQuality: groupPeriodLeads("quality"),
    bySource: groupPeriodLeads("source"),
  };

  // ── 6. Compute todayFollowups ──
  const todayFollowups = ((todayFollowupsRaw as any[]) || [])
    .flatMap((task: any) => {
      const lead = Array.isArray(task.leads) ? task.leads[0] : task.leads;
      return lead && !lead.final_status && lead.archived !== true ? [lead] : [];
    });

  // ── 7. Compute topActions ──
  const actions: TopAction[] = [];

  // 1. Overdue followups
  ((overdueFollowups as any[]) || []).forEach((task: any) => {
    const l = Array.isArray(task.leads) ? task.leads[0] : task.leads;
    if (!l || l.final_status) return;
    // Whole Dubai calendar days, the same figure analytics shows for this lead.
    const daysLate = overdueDays(task.due_at, nowDate);
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
      ? overdueDays(l.last_contact_date, nowDate)
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
    // Aggregates only: the browser no longer receives raw lead rows.
    leadStats,
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
        }
      : {}),
  };

  return applyPrivateNoStore(NextResponse.json(result));
}
