"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { whatsappHref as whatsappLink } from "@/lib/lead-contact.mjs";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { localizeServerText } from "@/lib/i18n/server-text.mjs";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { cn } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";
import AlertPanel from "./_components/AlertPanel";
import WeeklyReview from "./_components/WeeklyReview";
import { ErrorState } from "@/components/ui/error-state";
import { dubaiMonthElapsedPct, dubaiMonthKey, recentDubaiMonthKeys } from "@/lib/dubai-time.mjs";
import { summarizeLeads, type LeadSummary } from "@/lib/lead-metrics.mjs";
import { onFetchFailure } from "@/lib/fetch-interruption";
import { startEarlyFetch } from "@/lib/early-fetch";
import { formatAED } from "@/lib/display-format.mjs";
import { translatedOrRaw } from "@/lib/chart-labels.mjs";

/* ─── Types ─── */
interface Lead {
  id: string; customer_name: string | null; phone: string | null;
  source: string; stage: string; final_status: string | null; quotation_value: number | null;
  location: string | null; property_type: string | null;
  ai_quality: string | null; lead_status: string | null;
  assigned_to: string | null; win_probability: number | null;
  won_at: string | null;
  last_contact_date: string | null; created_at: string; updated_at: string;
  next_followup_date: string | null; next_action: string | null;
  followup_count: number | null;
  recovery_candidate: boolean; transfer_candidate: boolean;
  sales_manager_review: boolean; hold_since: string | null;
  campaign_name: string | null; source_platform: string | null;
  owner: string | null; sales_manager: string | null;
}

// R5: three local declarations of money rows used to sit here — Contract, Payment
// and InstallmentPlan — and none of them was referenced anywhere in the file. This
// page reads its finance figures from /api/dashboard/summary, which derives them
// with countsAsCash() from src/lib/payment-state.mjs. `Payment` in particular
// declared `confirmed: boolean` and no void field, i.e. the two-state model B8
// removed from the payments dashboard, sitting unused next to code that would
// otherwise have been the obvious thing to type against.

interface FollowupTask {
  lead_id: string;
  due_at: string;
  leads: Lead | Lead[] | null;
}

type ReviewRange = "today" | "this_week" | "last_week" | "this_month" | "custom";

/* ─── 9-stage funnel ─── */
const STAGE_KEYS = ["new","contacted","requirement_confirmed","solution_submitted","quotation_submitted","negotiation","pending_decision","won","lost"] as const;
const STAGE_COLORS: Record<string,string> = {
  new: "#6B7280", contacted: "#C48A52", requirement_confirmed: "#E0B95A",
  solution_submitted: "#4A5568", quotation_submitted: "#8B5CF6",
  negotiation: "#3B82F6", pending_decision: "#F59E0B", won: "#4ADE80", lost: "#6B7280",
};

// S37: one money format everywhere on the cockpit, whole dirhams: "AED 12,345".
const fmtAED = formatAED;

/* ─── Real financial data types ─── */
interface FinanceStats {
  totalContractValue: number;
  received: number;
  outstanding: number;
  overdue: number;
  dueNextWeek: number;
  dueNextWeekCount?: number;
  contractCount?: number;
  signedAmount?: number;
  paymentAmount?: number;
  wonCount?: number;
}

/* ─── shared: section header (module level: a component declared inside the page re-mounts every render) ─── */
function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-1 h-4 rounded-full bg-copper-400" />
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
    </div>
  );
}

/* ════════════════════════════════════════ */
export default function DashboardPage() {
  const router = useRouter();
  const { t, lang: language } = useLanguage();

  // Every lead figure on this page is computed on the server by
  // src/lib/lead-metrics.mjs (archived leads excluded, Dubai calendar months).
  const [leadStats, setLeadStats] = useState<LeadSummary>(() => summarizeLeads([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [showActivityFeed, setShowActivityFeed] = useState(false);
  
  // Period & KPI targets
  const [month, setMonth] = useState(() => dubaiMonthKey() as string);
  const [kpiTargets, setKpiTargets] = useState<any[]>([]);
  const lastMonth = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return m === 1 ? `${y-1}-12` : `${y}-${String(m-1).padStart(2, "0")}`;
  }, [month]);

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
  const [periodLeads, setPeriodLeads] = useState<{ count: number; byQuality: Record<string, number>; bySource: Record<string, number> } | null>(null);
  const [overdueFollowups, setOverdueFollowups] = useState<any[]>([]);

  const [weeklyReviewData, setWeeklyReviewData] = useState<{
    l1: { new_leads: number; contacted_leads: number; quality_judged: number; stage_advanced: number; won: number; lost: number };
    l2: Array<{ user_id: string; full_name: string | null; assigned_leads: number; contacted: number; pending_quality: number; quality_judged: number; stage_advanced: number; won: number; lost: number; overdue_tasks: number }>;
    l3_by_user: Record<string, Array<{ id: string; customer_name: string | null; assigned_to: string | null; owner_name: string | null; stage: string | null; last_contact_date: string | null; contact_count: number; quality: string | null; last_note: string | null; next_follow_up_at: string | null; period_reasons: string[]; overdue_count: number; stage_advance_count: number }>>;
    periodStart: string;
    periodEnd: string;
  } | null>(null);
  const reviewQuery = () => new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  const [weeklyReviewRange, setWeeklyReviewRange] = useState<ReviewRange>(() => {
    const range = reviewQuery().get("review_range");
    return range && ["today", "this_week", "last_week", "this_month", "custom"].includes(range)
      ? range as ReviewRange
      : "today";
  });
  const [weeklyReviewStart, setWeeklyReviewStart] = useState(() => reviewQuery().get("review_start") ?? "");
  const [weeklyReviewEnd, setWeeklyReviewEnd] = useState(() => reviewQuery().get("review_end") ?? "");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("review_range", weeklyReviewRange);
    if (weeklyReviewRange === "custom") {
      if (weeklyReviewStart) params.set("review_start", weeklyReviewStart);
      if (weeklyReviewEnd) params.set("review_end", weeklyReviewEnd);
    } else {
      params.delete("review_start");
      params.delete("review_end");
    }
    window.history.replaceState(null, "", window.location.pathname + "?" + params.toString());
  }, [weeklyReviewRange, weeklyReviewStart, weeklyReviewEnd]);

  useEffect(() => {
    // S22: this used to wait for the summary to supply `userRole`, which put the
    // weekly review one full round trip behind it. The server decides what the
    // caller may see (and answers the same for every role it served before), so
    // the request goes out together with the summary.
    if (weeklyReviewRange === "custom" && (!weeklyReviewStart || !weeklyReviewEnd || weeklyReviewStart > weeklyReviewEnd)) {
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ range: weeklyReviewRange });
    if (weeklyReviewRange === "custom") {
      params.set("start", weeklyReviewStart);
      params.set("end", weeklyReviewEnd);
    }
    fetch("/api/dashboard/weekly-review?" + params.toString())
      .then(async (r) => {
        if (!r.ok) { if (!cancelled) setWeeklyReviewData(null); return; }
        const json = await r.json();
        if (cancelled) return;
        setWeeklyReviewData({
          l1: json.l1,
          l2: json.l2 ?? [],
          l3_by_user: json.l3_by_user ?? {},
          periodStart: json.period_start ?? "",
          periodEnd: json.period_end ?? "",
        });
      })
      .catch(() => { if (!cancelled) setWeeklyReviewData(null); })
      .finally(() => undefined);
    return () => { cancelled = true; };
  }, [weeklyReviewRange, weeklyReviewStart, weeklyReviewEnd]);

  // S22: the alert banner is mounted only once the summary has rendered the
  // page, so its request used to start a full round trip after the summary
  // finished. It goes out at mount, together with the summary, and the panel
  // takes that request over (once; a month change does not start another).
  useEffect(() => {
    startEarlyFetch("/api/alerts");
  }, []);

  // ── Unified dashboard data fetch via server-side API ──
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/dashboard/summary?month=${month}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(json => {
        setUserId(json.profile.userId);
        setUserRole(json.profile.role);
        setSalesUsers(json.salesUsers);
        setLeadStats(json.leadStats);
        setFinanceStats(json.finance);
        setFinanceLoading(false);
        setContractCount(json.finance.contractCount);
        setKpiTargets(json.kpiTargets);
        setRiskPoolCount(json.riskPoolCount);
        setTodayFollowups(json.todayFollowups);
        setTopActions(json.topActions);
        setPeriodLeads(json.periodLeads ?? null);
        setOverdueFollowups(json.overdueFollowups ?? []);
        setFollowupLoading(false);
        setLoading(false);
      })
      .catch(err => {
        // An aborted request (effect cleanup, or the page navigating away) is not a
        // failure: nothing is logged and no error is shown. A real failure is.
        onFetchFailure(err, () => {
          // Never show the raw "HTTP 500" / "Failed to fetch": say it in the user's language.
          console.error("[dashboard] summary fetch failed:", err);
          setError(t("common.loadFailed"));
          setLoading(false);
        }, { signal: controller.signal });
      });
    return () => controller.abort();
  }, [month, language]);

  /* ─── Computed (from the server's single lead summary) ─── */
  const stats = useMemo(() => {
    const { stageCounts, stageValues } = leadStats;
    return {
      totalActive: leadStats.total,
      stageCounts, stageValues,
      pipelineSize: leadStats.active,
      totalPipeline: leadStats.pipelineValue,
      weightedPipeline: leadStats.weightedPipelineValue,
      // "Won" is what was won in the selected Dubai month (by won_at), the same
      // basis as the monthly signing target it is compared with.
      monthlyRevenue: leadStats.periodWonValue,
      wonCount: leadStats.periodWonCount,
      newThisWeek: leadStats.newLast7Days,
      conversionRate: leadStats.conversionRate,
      yellowCount: leadStats.yellowCount,
      redCount: leadStats.redCount,
      recoveryCount: leadStats.recoveryCount,
      transferCount: leadStats.transferCount,
      reviewCount: leadStats.reviewCount,
      highProbStale: leadStats.highProbStale,
      pendingStale: leadStats.pendingStale,
      statusCounts: leadStats.statusCounts,
      contactRate: leadStats.contactRate,
    };
  }, [leadStats]);

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
  // Both sides of "actual vs target" are for the selected Dubai month: the target
  // is a monthly figure, so the actual must not be the all-time total (it used to
  // be the sum of every lead ever won / every contract / every payment).
  // Signing = won in the month (won_at). The same definition for a rep (own leads)
  // and for management (all leads); contracts created, drafted, rejected or
  // terminated in the month never count as signed.
  const mySigningActual = leadStats.byAssignee[userId ?? ""]?.periodWonValue ?? 0;
  const signingActual = userRole === "sales" ? mySigningActual : leadStats.periodWonValue;
  const collectionActual = financeStats.paymentAmount ?? 0; // server scopes this to the caller's contracts for sales
  // "N won orders this month": the count that matches the signing amount beside it.
  const signingCount = userRole === "sales" ? (leadStats.byAssignee[userId ?? ""]?.periodWonCount ?? 0) : leadStats.periodWonCount;
  const signingPct = signingTarget > 0 ? Math.round((signingActual / signingTarget) * 100) : null;
  const collectionPct = collectionTarget > 0 ? Math.round((collectionActual / collectionTarget) * 100) : null;

  // Time-proportional expected progress (monthly)
  // Dubai days elapsed in the selected month (100 for past months).
  const expectedPct = useMemo(() => dubaiMonthElapsedPct(month), [month]);

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
    const sourceLabels: Record<string, string> = {
      ins: t("sourceLabels.ins"),
      fb: t("sourceLabels.fb"),
      show_room: t("sourceLabels.show_room"),
      whatsapp: t("sourceLabels.whatsapp"),
      website: t("sourceLabels.website"),
      offline: t("sourceLabels.offline"),
      other: t("sourceLabels.other"),
      unknown: t("sourceLabels.unknown"),
    };
    // Any other stored source code (unknown_import, referral, ...) is translated too, never shown raw.
    return Object.entries(leadStats.bySource)
      .filter(([, v]) => v.total > 0)
      .map(([k, v]) => ({ source: k, label: sourceLabels[k] || translatedOrRaw(t, `sourceLabels.${k}`, k), total: v.total, won: v.won, value: v.value }))
      .sort((a, b) => b.total - a.total);
  }, [leadStats, t]);
  const maxSourceTotal = Math.max(...sourceBreakdown.map(s => s.total), 1);
  
  // Per-salesperson breakdown
  const salesLeaderboard = useMemo(() => {
    const sales = salesUsers.filter((u: any) => u.role === "sales");
    return sales.map((s: any) => {
      const mine = leadStats.byAssignee[s.id];
      const target = kpiTargets.find((t: any) => t.target_type === "signing" && t.assigned_to === s.id);
      // This month's won value against this month's target.
      const wonValue = mine?.periodWonValue ?? 0;
      const targetAmount = target?.target_amount || 0;
      const completionRate = targetAmount > 0 ? Math.round((wonValue / targetAmount) * 100) : 0;
      return {
        id: s.id,
        name: s.full_name || s.email || t("common.unnamed"),
        wonValue,
        wonCount: mine?.periodWonCount ?? 0,
        pipelineValue: mine?.pipelineValue ?? 0,
        activeCount: mine?.active ?? 0,
        totalLeads: mine?.total ?? 0,
        contacted: mine?.contacted ?? 0,
        conversionRate: mine && mine.total > 0 ? Math.round((mine.won / mine.total) * 100) : 0,
        targetAmount,
        completionRate,
        imported: mine?.imported ?? 0,
        active: mine?.active ?? 0,
        won: mine?.won ?? 0,
        lost: mine?.lost ?? 0,
      };
    }).sort((a, b) => b.wonValue - a.wonValue);
  }, [salesUsers, leadStats, kpiTargets, t]);

  // KPI-driven finance cards — replaces old kpiCards + financeCards
  const getKpiSub = (actual: number, target: number) => {
    if (target <= 0) return t("kpi.noTargetSet");
    const pct = Math.round((actual / target) * 100);
    return `${t("dashboard.completionRate")} ${pct}% · ${t("dashboard.target2")} ${fmtAED(target)}`;
  };

  // No more financeCards array — render L1 cards inline

  if (loading) return <div className="flex items-center justify-center h-64 text-muted-foreground">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} retryText={t("common.retry")} onRetry={() => window.location.reload()} />;

  const isManagement = userRole !== "sales";
  const weeklyReviewProps = { month, finance: financeStats, signingPct, collectionPct, signingTarget, collectionTarget,
    periodLeads, topActions, riskPoolCount, todayFollowups, overdueFollowups, redCount: stats.redCount,
    yellowCount: stats.yellowCount, highProbStale: stats.highProbStale, pendingStale: stats.pendingStale,
    recoveryCount: stats.recoveryCount, transferCount: stats.transferCount, reviewCount: stats.reviewCount,
    isLoading: loading, language };

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
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="h-9 px-3 text-sm rounded-lg border border-border/50 bg-background text-foreground"
        >
          {recentDubaiMonthKeys(12).map((m) => <option key={m} value={m}>{m}</option>)}
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

  /* ─── shared: KPI mini stat cards (each says what it counts) ─── */
  const fill = (text: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), text);
  const KpiStatCards = (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
      {[
        { label: t("s37.labels.leads"), value: String(stats.totalActive), sub: fill(t("s37.sub.weekNew"), { n: stats.newThisWeek }), caption: t("s37.captions.leads"), href: "/leads" },
        { label: t("s37.labels.contracts"), value: String(contractCount), sub: fill(t("s37.sub.contractsOpen"), { n: stats.pipelineSize }), caption: t("s37.captions.contracts"), href: "/contracts" },
        { label: t("s37.labels.quotes"), value: String(leadStats.quotedCount), sub: fill(t("s37.sub.quotationStage"), { n: stats.stageCounts.quotation_submitted }), caption: t("s37.captions.quotes"), href: "/quotes" },
        { label: t("s37.labels.pipelineValue"), value: fmtAED(stats.totalPipeline), sub: fill(t("s37.sub.valuedOf"), { n: leadStats.valuedCount, m: stats.pipelineSize }), caption: t("s37.captions.pipelineValue"), href: "/leads?stage=quotation_submitted" },
        { label: `${t("s37.labels.wonMonth")} (${month})`, value: fmtAED(stats.monthlyRevenue), sub: fill(t("s37.sub.wonCount"), { n: stats.wonCount }), caption: t("s37.captions.wonMonth"), href: "/leads?stage=won" },
        { label: t("s37.labels.conversion"), value: `${stats.conversionRate}%`, sub: fill(t("s37.sub.contactedPct"), { n: stats.contactRate }), caption: t("s37.captions.conversion"), href: "/leads" },
      ].map(card => (
        <button key={card.label}
          onClick={() => router.push(card.href)}
          className="p-3 rounded-lg border border-border/50 bg-card/50 hover:bg-accent/30 transition-all text-left group"
        >
          <p className="text-xs text-muted-foreground font-medium">{card.label}</p>
          <p className="text-lg font-bold text-foreground group-hover:text-copper-400 transition-colors">{card.value}</p>
          <p className="text-xs text-emerald-400/80">{card.sub}</p>
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{card.caption}</p>
        </button>
      ))}
    </div>
  );

  /* ─── quick action handlers ─── */
  const handleWhatsApp = (phone: string, customerName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const href = whatsappLink(phone);
    if (href) window.open(href, "_blank");
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
                  <span className="text-xs text-muted-foreground">{localizeServerText(action.reason, language)}</span>
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

  /* ════════════════════════════════════════
     MANAGEMENT VIEW
     KPI completion → pipeline stat cards → leaderboard → sources → today (compact)
     ════════════════════════════════════════ */
  if (isManagement) {
    // The four numbers a boss reads first. Each one carries a line saying what it counts.
    const coreCards = [
      { label: t("kpi.signing"), pct: signingPct, actual: signingActual, target: signingTarget, sub: t("kpi.wonOrders").replace("{n}", String(signingCount)), caption: t("s37.captions.signing") },
      { label: t("kpi.collection"), pct: collectionPct, actual: collectionActual, target: collectionTarget, sub: t("dashboard.ratePct").replace("{n}", String(financeStats.totalContractValue > 0 ? Math.round((financeStats.received / financeStats.totalContractValue) * 100) : 0)), caption: t("s37.captions.collection") },
      { label: t("payment.overdue"), pct: null, actual: financeStats.overdue, target: 0, sub: financeStats.overdue > 0 ? t("dashboard.needsFollowup") : t("dashboard.noTargetSet"), caption: t("s37.captions.overduePay"), alert: financeStats.overdue > 0 },
      // dueNextWeek is an AMOUNT; it used to be printed as "43796 pending", an amount shown as a count.
      { label: t("dashboard.dueNextWeek"), pct: null, actual: financeStats.dueNextWeek, target: 0, sub: financeStats.dueNextWeekCount ? fill(t("s37.sub.installments"), { n: financeStats.dueNextWeekCount }) : t("dashboard.noTargetSet"), caption: t("s37.captions.dueNextWeek") },
    ];
    const funnelRows = STAGE_KEYS
      .map((k) => ({ key: k, count: leadStats.stageCounts[k] ?? 0 }))
      .filter((r) => r.count > 0);
    const maxFunnel = Math.max(...funnelRows.map((r) => r.count), 1);

    return (
      <DashboardScrollContainer className="space-y-5">
        {Header}
        <AlertPanel count={leadStats.followUpOverdue} />

        {/* 1. Today's actions come first: what to do now */}
        <div>
          <SectionHeader title={t("dashboard.todaysActions")} subtitle={topActions.length > 0 ? t("dashboard.nItems").replace("{n}", String(topActions.length)) : t("s37.allClear")} />
          {TodayActions}
        </div>

        {/* 2. Four core numbers */}
        <div>
          <SectionHeader title={t("s37.coreTitle")} subtitle={month} />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {coreCards.map(card => (
              <div key={card.label}
                className={cn("p-4 rounded-xl border bg-card/50", card.alert ? "border-red-500/30" : "border-border/50")}
              >
                <p className="text-xs text-muted-foreground mb-1 font-medium">{card.label}</p>
                {card.pct !== null ? (
                  <>
                    <p className={cn("text-[32px] font-bold leading-none", pctColor(card.pct))}>{`${card.pct}%`}</p>
                    <div className="h-2 bg-muted rounded-full mt-2 mb-1 overflow-hidden">
                      <div className={cn("h-full rounded-full transition-all", barColor(card.pct))}
                        style={{ width: `${Math.min(card.pct ?? 0, 100)}%` }} />
                    </div>
                  </>
                ) : (
                  <p className={cn("text-[26px] font-bold leading-none", card.alert ? "text-red-400" : "text-foreground")}>
                    {fmtAED(card.actual)}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {card.pct !== null ? `${fmtAED(card.actual)} / ${fmtAED(card.target)} · ${card.sub}` : card.sub}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{card.caption}</p>
              </div>
            ))}
          </div>
        </div>

        {/* 3. Funnel (stages with no leads are hidden) */}
        {funnelRows.length > 0 && (
          <div>
            <SectionHeader title={t("s37.funnelTitle")} subtitle={t("s37.funnelCaption")} />
            <div className="space-y-1.5">
              {funnelRows.map((r) => (
                <button key={r.key} type="button" onClick={() => router.push(`/leads?stage=${r.key}`)}
                  className="w-full flex items-center gap-3 text-left group">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground group-hover:text-foreground">{t(`stages.${r.key}`)}</span>
                  <span className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(Math.round((r.count / maxFunnel) * 100), 3)}%`, backgroundColor: STAGE_COLORS[r.key] }} />
                  </span>
                  <span className="w-10 text-right text-sm font-medium">{r.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 4. Lead sources */}
        {sourceBreakdown.length > 0 && (
          <div>
            <SectionHeader title={t("s37.sourcesTitle")} subtitle={`${sourceBreakdown.reduce((a, b) => a + b.total, 0)} ${t("dashboard.leads")} · ${t("s37.sourcesCaption")}`} />
            <div className="space-y-2">
              {sourceBreakdown.map((s) => {
                const pct = Math.round((s.total / maxSourceTotal) * 100);
                const convRate = s.total > 0 ? Math.round((s.won / s.total) * 100) : 0;
                return (
                  <div key={s.source} className="p-3 rounded-xl border border-border/50 bg-card/50 group hover:border-copper-400/30 transition-all">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium">{s.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.total} {t("leads.title").toLowerCase()} · {s.won} {t("dashboard.won")} · {convRate}%
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

        {/* 5. Everything else, folded away */}
        <details className="rounded-xl border border-border/50 bg-card/30 group">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-foreground flex items-center justify-between">
            <span>{t("s37.detailsTitle")}</span>
            <span className="text-xs font-normal text-muted-foreground">{t("s37.detailsHint")}</span>
          </summary>
          <div className="space-y-5 p-4 pt-1">
            {KpiStatCards}

            {/* Weekly Review — L1/L2/L3 period review */}
            {weeklyReviewData ? (
              <WeeklyReview
                {...weeklyReviewProps}
                mode="period"
                l1={weeklyReviewData.l1}
                l2={weeklyReviewData.l2}
                l3_by_user={weeklyReviewData.l3_by_user}
                periodStart={weeklyReviewData.periodStart}
                periodEnd={weeklyReviewData.periodEnd}
                range={weeklyReviewRange}
                onRangeChange={setWeeklyReviewRange}
                customStart={weeklyReviewStart}
                customEnd={weeklyReviewEnd}
                onCustomRangeChange={(start, end) => {
                  setWeeklyReviewStart(start);
                  setWeeklyReviewEnd(end);
                }}
              />
            ) : (
              <WeeklyReview {...weeklyReviewProps} />
            )}

            {/* Sales Leaderboard */}
            {salesLeaderboard.length > 0 && (
              <div>
                <SectionHeader title={t("dashboard.salesLeaderboard")} subtitle={`(${month})`} />
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
                              {t("dashboard.wonThisMonth")} {fmtAED(s.wonValue)} ({s.wonCount}) · {language === "zh" ? "总计" : "Total"} {s.totalLeads} · {language === "zh" ? "导入" : "Imported"} {s.imported} · {language === "zh" ? "活跃" : "Active"} {s.active} · {language === "zh" ? "累计成交" : "Won to date"} {s.won} · {language === "zh" ? "流失" : "Lost"} {s.lost}
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
          </div>
        </details>
      </DashboardScrollContainer>
    );
  }

  /* ════════════════════════════════════════
     SALES VIEW
     Today's actions → my KPI → my pipeline → sources
     ════════════════════════════════════════ */
  return (
    <DashboardScrollContainer className="space-y-5">
      {Header}
      <AlertPanel count={leadStats.followUpOverdue} />

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
        <SectionHeader title={t("dashboard.myProgress")} subtitle={month} />
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
            <p className="text-xs text-muted-foreground">{fmtAED(signingActual)} / {fmtAED(signingTarget)} · {t("kpi.wonOrders").replace("{n}", String(signingCount))}</p>
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
                      {t("dashboard.sourceLine").replace("{n}", String(s.total)).replace("{won}", String(s.won)).replace("{pct}", String(convRate))}
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
      {weeklyReviewData ? (
        <WeeklyReview
          {...weeklyReviewProps}
          mode="period"
          l1={weeklyReviewData.l1}
          l2={weeklyReviewData.l2}
          l3_by_user={weeklyReviewData.l3_by_user}
          periodStart={weeklyReviewData.periodStart}
          periodEnd={weeklyReviewData.periodEnd}
          range={weeklyReviewRange}
          onRangeChange={setWeeklyReviewRange}
          customStart={weeklyReviewStart}
          customEnd={weeklyReviewEnd}
          onCustomRangeChange={(start, end) => {
            setWeeklyReviewStart(start);
            setWeeklyReviewEnd(end);
          }}
        />
      ) : (
        <WeeklyReview {...weeklyReviewProps} />
      )}
    </DashboardScrollContainer>
  );
}
