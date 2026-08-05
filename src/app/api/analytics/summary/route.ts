// RBAC: user (authenticated)
// GET /api/analytics/summary — Consolidated analytics data with 30s cache
// Aggregates: ads stats, funnel stats, revenue stats, lead conversion stats
// Server-side auth.getUser() → profile role → all queries in Promise.all
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { getCached, setCache } from "@/lib/api-cache";

/* ─── Helpers ─── */
function normalizeCampaign(name: string | null): string {
  if (!name) return "Uncategorized";
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-");
}

function normalizeMilestone(milestone: string): string {
  switch (milestone) {
    case "first_contact":  return "contacted";
    case "requirements":   return "requirement_confirmed";
    case "drawings":       return "solution_submitted";
    case "quotation":      return "quotation_submitted";
    case "meeting":        return "negotiation";
    default:               return milestone;
  }
}

const STAGE_DEFS = [
  { key: "new",                label: "New" },
  { key: "contacted",          label: "Contacted" },
  { key: "requirement_confirmed", label: "Req. Confirmed" },
  { key: "solution_submitted", label: "Solution Sub." },
  { key: "quotation_submitted",label: "Quotation Sub." },
  { key: "negotiation",        label: "Negotiation" },
  { key: "pending_decision",   label: "Pending Decision" },
  { key: "won",                label: "Won" },
  { key: "lost",               label: "Lost" },
];

export async function GET(request: Request) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

  // 1. Auth
  const { data: { user } } = await supabase.auth.getUser();
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
  const isCEO = isManagement;

  // ── Cache key ──
  const cacheKey = `analytics-summary:${role}:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  // ── Date helpers ──
  const now = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const nextWeekDate = new Date();
  nextWeekDate.setDate(nextWeekDate.getDate() + 7);
  const nextWeekStr = nextWeekDate.toISOString().slice(0, 10);

  // ── Compute ISO weeks for trends ──
  const isoWeeks: { year: number; week: number; start: string; end: string }[] = [];
  const nowDate = new Date();
  const dayOfWeek = nowDate.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const currentMonday = new Date(nowDate);
  currentMonday.setDate(nowDate.getDate() + mondayOffset);
  currentMonday.setHours(0, 0, 0, 0);

  for (let i = 11; i >= 0; i--) {
    const start = new Date(currentMonday);
    start.setDate(currentMonday.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    const temp = new Date(start);
    const dayNum = (temp.getDay() + 6) % 7;
    temp.setDate(temp.getDate() - dayNum + 3);
    const firstThursday = temp.getTime();
    const yearStart = new Date(temp.getFullYear(), 0, 1).getTime();
    const weekNum = 1 + Math.round((firstThursday - yearStart) / 86_400_000 / 7);
    isoWeeks.push({ year: start.getFullYear(), week: weekNum, start: start.toISOString(), end: end.toISOString() });
  }

  const rangeStart = isoWeeks[0].start;
  const rangeEnd = isoWeeks[isoWeeks.length - 1].end;

  // ══════════════════════════════════════════
  // Batch 1: Independent parallel queries
  // ══════════════════════════════════════════

  // ── 3a. Leads (full) ──
  let leadsQuery = supabase.from("leads").select("*").eq("archived", false);
  if (!isManagement) leadsQuery = leadsQuery.eq("assigned_to", userId);
  const leadsPromise = leadsQuery;

  // ── 3b. Contracts with installment plans ──
  let contractQuery = supabase
    .from("contracts")
    .select(`id, contract_no, contract_amount, contract_date, status, sales_id, party_a_name, lead_id, leads!inner(customer_name, assigned_to), installment_plans(id, seq, amount, due_date, status, paid_amount), payments(id, amount, confirmed, payment_date)`)
    .order("created_at", { ascending: false });
  if (!isManagement) contractQuery = contractQuery.eq("sales_id", userId);
  const contractsPromise = contractQuery;

  // ── 3c. Ad spend ──
  const adSpendPromise = supabase.from("ad_spend").select("campaign_name, amount, spend_date").order("spend_date", { ascending: true });

  // ── 3d. Sales profiles ──
  const salesProfilesPromise = supabase
    .from("profiles")
    .select("id, full_name, email, role")
    .in("role", ["sales", "admin"])
    .eq("is_active", true);

  // ── 3e. Leads for trends (12-week range) ──
  let trendsLeadsQuery = supabase
    .from("leads")
    .select("id, created_at, stage, quotation_value, assigned_to, final_status")
    .eq("archived", false)
    .gte("created_at", rangeStart)
    .lte("created_at", rangeEnd);
  if (!isManagement) trendsLeadsQuery = trendsLeadsQuery.eq("assigned_to", userId);
  const trendsLeadsPromise = trendsLeadsQuery;

  // ── 3f. Contracts for trends ──
  let trendsContractsQuery = supabase
    .from("contracts")
    .select("id, contract_amount, created_at, status, sales_id")
    .gte("created_at", rangeStart)
    .lte("created_at", rangeEnd);
  if (!isManagement) trendsContractsQuery = trendsContractsQuery.eq("sales_id", userId);
  const trendsContractsPromise = trendsContractsQuery;

  // ── 3g. Payments for trends ──
  let trendsPaymentsQuery = supabase
    .from("payments")
    .select("id, amount, confirmed, payment_date, contract_id")
    .gte("payment_date", rangeStart)
    .lte("payment_date", rangeEnd)
    .eq("confirmed", true);
  if (!isManagement) {
    const { data: userContracts } = await supabase.from("contracts").select("id").eq("sales_id", userId);
    const uids = (userContracts || []).map((c: any) => c.id);
    if (uids.length > 0) trendsPaymentsQuery = trendsPaymentsQuery.in("contract_id", uids);
    else trendsPaymentsQuery = trendsPaymentsQuery.eq("contract_id", "");
  }
  const trendsPaymentsPromise = trendsPaymentsQuery;

  const [
    { data: leads, error: leadsErr },
    { data: contracts, error: contractsErr },
    { data: adSpend, error: adErr },
    { data: salesProfiles, error: spErr },
    { data: trendsLeads, error: tlErr },
    { data: trendsContracts, error: tcErr },
    { data: trendsPayments, error: tpErr },
  ] = await Promise.all([
    leadsPromise, contractsPromise, adSpendPromise,
    salesProfilesPromise, trendsLeadsPromise,
    trendsContractsPromise, trendsPaymentsPromise,
  ]);

  if (leadsErr) console.error("[analytics-summary] leads fetch failed:", leadsErr);
  if (contractsErr) console.error("[analytics-summary] contracts fetch failed:", contractsErr);
  if (adErr) console.error("[analytics-summary] ad spend fetch failed:", adErr);

  const leadsData = (leads || []) as any[];
  const contractsData = (contracts || []) as any[];
  const adSpendData = (adSpend || []) as any[];
  const salesUsers = (salesProfiles || []) as any[];

  // ══════════════════════════════════════════
  // 4. COMPUTE: Lead Health
  // ══════════════════════════════════════════
  const totalLeads = leadsData.length;
  const weeklyNew = leadsData.filter((l: any) => l.created_at >= weekAgo).length;

  const activeLeads = leadsData.filter((l: any) => !l.final_status);
  const activeCount = activeLeads.length;
  const activePct = totalLeads > 0 ? Math.round((activeCount / totalLeads) * 100) : 0;

  const dormantCount = leadsData.filter((l: any) =>
    l.lead_status === "dormant" ||
    (l.last_contact_date && l.last_contact_date < fourteenDaysAgo && !l.final_status)
  ).length;
  const dormantPct = totalLeads > 0 ? Math.round((dormantCount / totalLeads) * 100) : 0;

  const zeroFollowupLeads = leadsData.filter((l: any) =>
    !l.followup_count || l.followup_count === 0 || !l.last_contact_date
  );
  const zeroCount = zeroFollowupLeads.length;
  const zeroPct = totalLeads > 0 ? Math.round((zeroCount / totalLeads) * 100) : 0;

  // Quality breakdown
  const qualityBreakdown: Record<string, number> = { pending: 0, good: 0, bad: 0, unknown: 0 };
  for (const l of leadsData) {
    const q = (l.quality || l.ai_quality || "unknown").toLowerCase();
    if (qualityBreakdown[q] !== undefined) qualityBreakdown[q]++;
    else qualityBreakdown.unknown++;
  }

  // Overdue
  const overdueRaw = leadsData.filter((l: any) =>
    (l.next_followup_date && l.next_followup_date < now) ||
    (!l.last_contact_date && l.created_at < twoDaysAgo)
  );
  const assignedIds = [...new Set(overdueRaw.map((r: any) => r.assigned_to).filter(Boolean))];
  let nameMap: Record<string, string> = {};
  if (assignedIds.length > 0) {
    const { data: users } = await supabase.from("profiles").select("id, full_name").in("id", assignedIds);
    (users ?? []).forEach((u: any) => { nameMap[u.id] = u.full_name; });
  }
  const overdueList = overdueRaw.map((r: any) => {
    const overdueDays = r.next_followup_date
      ? Math.max(0, Math.floor((Date.now() - new Date(r.next_followup_date).getTime()) / 86_400_000))
      : Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86_400_000) - 2);
    return {
      id: r.id, customer_name: r.customer_name, phone: r.phone,
      assigned_to: r.assigned_to, assigned_name: nameMap[r.assigned_to] || null,
      stage: r.stage, last_contact_date: r.last_contact_date,
      next_followup_date: r.next_followup_date, overdue_days: overdueDays,
      quotation_value: r.quotation_value,
    };
  }).sort((a: any, b: any) => b.overdue_days - a.overdue_days).slice(0, 20);

  const leadHealth = { totalLeads, weeklyNew, activeCount, activePct, dormantCount, dormantPct, zeroCount, zeroPct, qualityBreakdown, overdue: overdueList, isCEO };

  // ══════════════════════════════════════════
  // 5. COMPUTE: Pipeline Funnel
  // ══════════════════════════════════════════
  const stageCountMap: Record<string, number> = {};
  const stageLeads: Record<string, any[]> = {};
  for (const def of STAGE_DEFS) { stageCountMap[def.key] = 0; stageLeads[def.key] = []; }
  for (const l of leadsData) {
    const s = l.final_status || normalizeMilestone(l.current_milestone || "");
    if (!s) continue;
    if (stageCountMap[s] !== undefined) { stageCountMap[s]++; stageLeads[s].push(l); }
  }

  const calcAvgDays = (leadsInStage: any[]): number => {
    if (leadsInStage.length === 0) return 0;
    const nowMs = Date.now();
    let total = 0, count = 0;
    for (const l of leadsInStage) {
      const ref = l.updated_at || l.created_at;
      if (!ref) continue;
      total += (nowMs - new Date(ref).getTime()) / 86_400_000;
      count++;
    }
    return count > 0 ? Math.round((total / count) * 10) / 10 : 0;
  };

  const topCount = stageCountMap[STAGE_DEFS[0].key] || 1;
  const funnelStages = STAGE_DEFS.map((def, idx) => {
    const count = stageCountMap[def.key] || 0;
    const pctOfTop = topCount > 0 ? Math.round((count / topCount) * 100) : 0;
    const avgDaysInStage = calcAvgDays(stageLeads[def.key]);
    const nextDef = STAGE_DEFS[idx + 1];
    let conversionToNext: number | null = null;
    if (nextDef && def.key !== "lost" && def.key !== "won") {
      const nextCount = stageCountMap[nextDef.key] || 0;
      conversionToNext = count > 0 ? Math.round((nextCount / count) * 100) : 0;
    }
    const isBottleneck = conversionToNext !== null && conversionToNext < 30 && count > 3 && def.key !== "won" && def.key !== "lost";
    return { key: def.key, label: def.label, count, pctOfTop, conversionToNext, avgDaysInStage, isBottleneck };
  });

  // Stuck leads
  const stuckLeads: { id: string; customer_name: string | null; days_in_stage: number; stage_label: string }[] = [];
  const nowMs = Date.now();
  for (const def of STAGE_DEFS) {
    if (def.key === "won" || def.key === "lost") continue;
    const avg = funnelStages.find(s => s.key === def.key)?.avgDaysInStage || 1;
    const threshold = avg * 2;
    if (threshold <= 0) continue;
    for (const l of stageLeads[def.key] || []) {
      const ref = l.updated_at || l.created_at;
      if (!ref) continue;
      const days = (nowMs - new Date(ref).getTime()) / 86_400_000;
      if (days > threshold) stuckLeads.push({ id: l.id, customer_name: l.customer_name, days_in_stage: Math.round(days), stage_label: def.label });
    }
  }
  stuckLeads.sort((a, b) => b.days_in_stage - a.days_in_stage);

  // Lost from stage
  const lostFromStage: Record<string, number> = {};
  const lostStageObj = funnelStages.find(s => s.key === "lost");
  if (lostStageObj && (lostStageObj.count || 0) > 0) {
    // Count lost leads by their original stage
    const lostLeads = leadsData.filter((l: any) => l.final_status === "lost");
    for (const l of lostLeads) {
      const fromStage = l.stage || "unknown";
      lostFromStage[fromStage] = (lostFromStage[fromStage] || 0) + 1;
    }
  }

  const pipelineFunnel = { stages: funnelStages, stuckLeads, totalLeads, lostFromStage };

  // ══════════════════════════════════════════
  // 6. COMPUTE: Payment Tracker (Revenue)
  // ══════════════════════════════════════════
  let totalContractValue = 0;
  let collected = 0;
  let overdueTotal = 0;
  let dueThisWeekTotal = 0;
  const allInstallments: any[] = [];

  for (const contract of contractsData) {
    const amount = contract.contract_amount || 0;
    totalContractValue += amount;

    for (const p of contract.payments || []) {
      if (p.confirmed) collected += p.amount || 0;
    }

    for (const inst of contract.installment_plans || []) {
      const paid = inst.paid_amount || 0;
      const dueDate = inst.due_date;
      let status = inst.status;
      if (status !== "paid" && status !== "cancelled") {
        if (paid >= inst.amount) status = "paid";
        else if (dueDate < today) status = "overdue";
        else if (dueDate >= today && dueDate <= nextWeekStr) status = "due_soon";
        else status = "pending";
      }
      const overdueDays = status === "overdue" && dueDate ? Math.floor((new Date(today).getTime() - new Date(dueDate).getTime()) / 86_400_000) : 0;
      if (status === "overdue") overdueTotal += (inst.amount - paid);
      if (status === "due_soon") dueThisWeekTotal += (inst.amount - paid);
      const leadInfo = Array.isArray(contract.leads) ? contract.leads[0] : contract.leads;
      const customerName = leadInfo?.customer_name || contract.party_a_name || "Unknown";
      allInstallments.push({
        id: inst.id, contract_id: contract.id, contract_no: contract.contract_no,
        contract_amount: contract.contract_amount, customer_name: customerName,
        sales_id: contract.sales_id, seq: inst.seq, amount: inst.amount,
        due_date: inst.due_date, status, overdue_days: overdueDays, paid_amount: paid,
      });
    }
  }

  allInstallments.sort((a, b) => {
    if (a.status === "overdue" && b.status !== "overdue") return -1;
    if (a.status !== "overdue" && b.status === "overdue") return 1;
    return b.overdue_days - a.overdue_days || (a.due_date < b.due_date ? -1 : 1);
  });

  // Per-rep collection
  const repMap: Record<string, { full_name: string; signed: number; collected: number; overdue: number }> = {};
  for (const p of salesUsers) { repMap[p.id] = { full_name: p.full_name || "Unknown", signed: 0, collected: 0, overdue: 0 }; }
  for (const contract of contractsData) {
    const sid = contract.sales_id || "unassigned";
    if (!repMap[sid]) repMap[sid] = { full_name: "Unassigned", signed: 0, collected: 0, overdue: 0 };
    repMap[sid].signed += contract.contract_amount || 0;
    for (const p of contract.payments || []) { if (p.confirmed) repMap[sid].collected += p.amount || 0; }
    for (const inst of contract.installment_plans || []) {
      if (inst.status !== "paid" && inst.status !== "cancelled" && inst.due_date < today) repMap[sid].overdue++;
    }
  }
  const perRep = Object.entries(repMap)
    .filter(([id]) => id !== "unassigned")
    .map(([uid, d]) => ({
      user_id: uid, full_name: d.full_name, signed_amount: d.signed,
      collected: d.collected, collection_rate: d.signed > 0 ? Math.round((d.collected / d.signed) * 100) : 0,
      overdue_count: d.overdue,
    }))
    .sort((a, b) => b.signed_amount - a.signed_amount);

  const paymentTracker = {
    summary: {
      totalContractValue: Math.round(totalContractValue),
      collected: Math.round(collected),
      outstanding: Math.round(totalContractValue - collected),
      overdue: Math.round(overdueTotal),
      dueThisWeek: Math.round(dueThisWeekTotal),
    },
    installments: allInstallments,
    perRep,
  };

  // ══════════════════════════════════════════
  // 7. COMPUTE: Ads ROI
  // ══════════════════════════════════════════
  const totalSpend = adSpendData.reduce((sum: number, row: any) => sum + (parseFloat(row.amount) || 0), 0);
  const spendByCampaign: Record<string, number> = {};
  const displayNameMap: Record<string, string> = {};
  for (const row of adSpendData) {
    const raw = row.campaign_name || "Uncategorized";
    const c = normalizeCampaign(raw);
    spendByCampaign[c] = (spendByCampaign[c] || 0) + (parseFloat(row.amount) || 0);
    if (!displayNameMap[c]) displayNameMap[c] = raw;
  }

  const metaLeads = leadsData.filter((l: any) => ["ins", "fb"].includes(l.source));
  const totalMetaLeads = metaLeads.length;
  const leadsByCampaign: Record<string, number> = {};
  const conversionsByCampaign: Record<string, number> = {};
  const signedAmountByCampaign: Record<string, number> = {};
  for (const lead of metaLeads) {
    const raw = lead.campaign_name || "Uncategorized";
    const c = normalizeCampaign(raw);
    if (!displayNameMap[c]) displayNameMap[c] = raw;
    leadsByCampaign[c] = (leadsByCampaign[c] || 0) + 1;
    if (lead.final_status === "won") {
      conversionsByCampaign[c] = (conversionsByCampaign[c] || 0) + 1;
      signedAmountByCampaign[c] = (signedAmountByCampaign[c] || 0) + (parseFloat(String(lead.quotation_value || "")) || 0);
    }
  }

  const totalConversions = metaLeads.filter((l: any) => l.final_status === "won").length;
  const totalSignedAmount = metaLeads.filter((l: any) => l.final_status === "won")
    .reduce((sum: number, l: any) => sum + (parseFloat(String(l.quotation_value || "")) || 0), 0);

  const allCampaigns = new Set([...Object.keys(spendByCampaign), ...Object.keys(leadsByCampaign)]);
  const campaignBreakdown = Array.from(allCampaigns).map((c) => {
    const spend = spendByCampaign[c] || 0;
    const lds = leadsByCampaign[c] || 0;
    const conv = conversionsByCampaign[c] || 0;
    const signedAmt = signedAmountByCampaign[c] || 0;
    return {
      campaign: displayNameMap[c] || c, campaign_key: c,
      spend: Math.round(spend * 100) / 100, leads: lds,
      cpl: lds > 0 ? Math.round((spend / lds) * 100) / 100 : 0,
      conversions: conv, signed_amount: Math.round(signedAmt * 100) / 100,
      roas: spend > 0 ? Math.round((signedAmt / spend) * 100) / 100 : 0,
    };
  }).sort((a, b) => b.spend - a.spend);

  // Source quality
  const sourceQuality: Record<string, { total: number; good: number; pending: number; bad: number; won: number }> = {};
  for (const l of leadsData) {
    const src = l.source || "unknown";
    if (!sourceQuality[src]) sourceQuality[src] = { total: 0, good: 0, pending: 0, bad: 0, won: 0 };
    sourceQuality[src].total++;
    const q = (l.ai_quality || "pending").toLowerCase();
    if (q === "good" || q === "hot") sourceQuality[src].good++;
    else if (q === "bad" || q === "cold") sourceQuality[src].bad++;
    else sourceQuality[src].pending++;
    if (l.final_status === "won") sourceQuality[src].won++;
  }
  const sourceQualityBreakdown = Object.entries(sourceQuality)
    .map(([s, d]) => ({ source: s, total: d.total, good: d.good, pending: d.pending, bad: d.bad, conv_rate: d.total > 0 ? Math.round((d.won / d.total) * 10000) / 100 : 0 }))
    .sort((a, b) => b.total - a.total);

  const startDate = adSpendData.length > 0 ? adSpendData[0].spend_date : null;
  const endDate = adSpendData.length > 0 ? adSpendData[adSpendData.length - 1].spend_date : null;
  const overallCpl = totalMetaLeads > 0 ? Math.round((totalSpend / totalMetaLeads) * 100) / 100 : 0;
  const overallRoas = totalSpend > 0 ? Math.round((totalSignedAmount / totalSpend) * 100) / 100 : 0;

  const adsRoi = {
    period: { start_date: startDate, end_date: endDate },
    summary: { total_spend: Math.round(totalSpend * 100) / 100, total_leads: totalMetaLeads, cpl: overallCpl, conversions: totalConversions, signed_amount: Math.round(totalSignedAmount * 100) / 100, roas: overallRoas },
    campaign_breakdown: campaignBreakdown,
    source_quality: sourceQualityBreakdown,
  };

  // ══════════════════════════════════════════
  // 8. COMPUTE: Sales Load
  // ══════════════════════════════════════════
  let salesLoad: any;
  if (isCEO) {
    const leadsByRep: Record<string, any[]> = {};
    for (const l of leadsData) {
      if (!leadsByRep[l.assigned_to]) leadsByRep[l.assigned_to] = [];
      leadsByRep[l.assigned_to].push(l);
    }
    const wonAmountByRep: Record<string, number> = {};
    for (const c of contractsData) {
      if (c.status !== "terminated" && c.sales_id) {
        wonAmountByRep[c.sales_id] = (wonAmountByRep[c.sales_id] ?? 0) + (c.contract_amount ?? 0);
      }
    }
    const repStats = salesUsers.filter((r: any) => r.role === "sales").map((rep: any) => {
      const myLeads = leadsByRep[rep.id] || [];
      const tl = myLeads.length;
      const wonLeads = myLeads.filter((l: any) => l.final_status === "won").length;
      const contacted = myLeads.filter((l: any) => l.last_contact_date || (l.followup_count ?? 0) > 0).length;
      const cr = tl > 0 ? Math.round((wonLeads / tl) * 100) : 0;
      const fr = tl > 0 ? Math.round((contacted / tl) * 100) : 0;
      const sd: Record<string, number> = {};
      myLeads.forEach((l: any) => { sd[l.stage] = (sd[l.stage] ?? 0) + 1; });
      const ov = myLeads.filter((l: any) => l.next_followup_date && l.next_followup_date < now && !l.final_status).length;
      return { id: rep.id, name: rep.full_name || rep.email, email: rep.email, role: rep.role, totalLeads: tl, wonAmount: wonAmountByRep[rep.id] ?? 0, wonLeads, conversionRate: cr, followupRate: fr, stageDistribution: sd, overdueCount: ov, transferableLeads: myLeads.filter((l: any) => l.stage === "new" && !l.last_contact_date).map((l: any) => ({ id: l.id })) };
    });
    const avgLoad = repStats.length > 0 ? repStats.reduce((s: number, r: any) => s + r.totalLeads, 0) / repStats.length : 0;
    const threshold = avgLoad * 1.5;
    const overloaded = repStats.filter((r: any) => r.totalLeads > threshold);
    const underloaded = repStats.filter((r: any) => r.totalLeads < avgLoad);
    salesLoad = { repStats, avgLoad: Math.round(avgLoad * 10) / 10, imbalanceDetected: overloaded.length > 0 && underloaded.length > 0, overloaded: overloaded.map((r: any) => ({ id: r.id, name: r.name, totalLeads: r.totalLeads })), underloaded: underloaded.map((r: any) => ({ id: r.id, name: r.name, totalLeads: r.totalLeads })), isCEO: true };
  } else {
    const myLeads = leadsData;
    const tl = myLeads.length;
    const sd: Record<string, number> = {};
    let contactedCount = 0, overdueCountLocal = 0;
    for (const l of myLeads) {
      sd[l.stage] = (sd[l.stage] ?? 0) + 1;
      if (l.last_contact_date || (l.followup_count ?? 0) > 0) contactedCount++;
      if (l.next_followup_date && l.next_followup_date < now && !l.final_status) overdueCountLocal++;
    }
    const fr = tl > 0 ? Math.round((contactedCount / tl) * 100) : 0;
    salesLoad = { totalLeads: tl, stageDistribution: sd, followupRate: fr, overdueCount: overdueCountLocal, isCEO: false };
  }

  // ══════════════════════════════════════════
  // 9. COMPUTE: Weekly Trends
  // ══════════════════════════════════════════
  const weeklyData = isoWeeks.map((week) => {
    const newLeads = (trendsLeads || []).filter((l: any) => {
      const c = new Date(l.created_at);
      return c >= new Date(week.start) && c <= new Date(week.end);
    });
    const wonLeadsInWeek = newLeads.filter((l: any) => l.final_status === "won");
    const weekContracts = (trendsContracts || []).filter((c: any) => {
      const cr = new Date(c.created_at);
      return cr >= new Date(week.start) && cr <= new Date(week.end) && c.status !== "terminated";
    });
    const signedAmount = weekContracts.reduce((sum: number, c: any) => sum + (parseFloat(c.contract_amount as any) || 0), 0);
    const weekPayments = (trendsPayments || []).filter((p: any) => {
      const pd = new Date(p.payment_date);
      return pd >= new Date(week.start) && pd <= new Date(week.end);
    });
    const collectedAmount = weekPayments.reduce((sum: number, p: any) => sum + (parseFloat(p.amount as any) || 0), 0);
    const nc = newLeads.length;
    const wc = wonLeadsInWeek.length;
    const convRate = nc > 0 ? Math.round((wc / nc) * 10000) / 100 : 0;
    return { year: week.year, week: week.week, start_date: week.start.split("T")[0], end_date: week.end.split("T")[0], new_leads: nc, signed_amount: Math.round(signedAmount * 100) / 100, conversion_rate: convRate, collected_amount: Math.round(collectedAmount * 100) / 100 };
  });

  const calcWow = (curr: number, prev: number) => {
    if (prev === 0) return { change_pct: curr > 0 ? 100 : 0, direction: curr > 0 ? "up" as const : "flat" as const };
    const pct = Math.round(((curr - prev) / prev) * 10000) / 100;
    return { change_pct: Math.abs(pct), direction: pct > 0 ? "up" as const : pct < 0 ? "down" as const : "flat" as const };
  };
  const cw = weeklyData[weeklyData.length - 1];
  const pw = weeklyData[weeklyData.length - 2];
  const wowComparison = {
    new_leads: calcWow(cw.new_leads, pw.new_leads),
    signed_amount: calcWow(cw.signed_amount, pw.signed_amount),
    conversion_rate: calcWow(cw.conversion_rate, pw.conversion_rate),
    collected_amount: calcWow(cw.collected_amount, pw.collected_amount),
  };
  const weeklyTrends = { weeks: weeklyData, wow_comparison: wowComparison };

  // ══════════════════════════════════════════
  // 10. Build response
  // ══════════════════════════════════════════
  const result = {
    profile: { userId, role },
    leadHealth,
    pipelineFunnel,
    paymentTracker,
    adsRoi,
    salesLoad,
    weeklyTrends,
  };

  setCache(cacheKey, result, 30);
  return NextResponse.json(result);
}
