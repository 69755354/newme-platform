"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

// ─── API-mode response types (PRD §五.3 / GET /api/dashboard/weekly-review) ───
type Period = "this_week" | "last_week" | "this_month";
interface WeeklyReviewL1 {
  newLeads: number; contactedLeads: number; qualityChecked: number;
  stageMoved: number; won: number; lost: number;
}
interface WeeklyReviewL2 {
  salesId: string; salesName: string;
  assigned: number; contacted: number; pendingQuality: number;
  stageMoved: number; won: number; lost: number; overdueTasks: number;
}
interface WeeklyReviewL3 {
  leadId: string | null; leadName: string | null; currentStage: string | null;
  lastContact: string | null; quality: string | null; nextFollowUp: string | null;
  movedTo: string | null; movedBy: string | null; movedAt: string | null;
}
interface WeeklyReviewApiResponse {
  period: Period; periodStart: string; periodEnd: string;
  l1: WeeklyReviewL1; l2: WeeklyReviewL2[]; l3: WeeklyReviewL3[];
}

// ─── Period-mode types (mode="period", PRD §5.3 snake_case BFF response) ───
// Caller passes pre-fetched data; component renders L1/L2/L3 without fetching.
interface PeriodL1 {
  new_leads: number; contacted_leads: number; quality_judged: number;
  stage_advanced: number; won: number; lost: number;
}
interface PeriodL2Row {
  user_id: string; full_name: string | null;
  assigned_leads: number; contacted: number; pending_quality: number;
  stage_advanced: number; won: number; lost: number; overdue_tasks: number;
}
interface PeriodL3Row {
  id: string; customer_name: string | null;
  assigned_to: string | null; owner_name: string | null;
  stage: string | null; last_contact_date: string | null;
  contact_count: number; quality: string | null;
  last_note: string | null; next_follow_up_at: string | null;
}

interface FinanceStats {
  totalContractValue: number; received: number; outstanding: number;
  overdue: number; dueNextWeek: number; contractCount?: number;
  contractAmount?: number; paymentAmount?: number; wonCount?: number;
}
interface TopAction { customerName?: string; reason?: string; leadId?: string; }
interface Lead { id?: string; customer_name?: string | null; }
interface WeeklyReviewProps {
  month: string; finance: FinanceStats; signingPct: number | null; collectionPct: number | null;
  signingTarget: number; collectionTarget: number;
  periodLeads: { count: number; byQuality: Record<string, number>; bySource: Record<string, number> } | null;
  topActions: TopAction[]; riskPoolCount: number | null; todayFollowups: Lead[]; overdueFollowups: any[];
  redCount: number; yellowCount: number; highProbStale: number; pendingStale: number;
  recoveryCount: number; transferCount: number; reviewCount: number; isLoading: boolean; language: string;
  /** Opt-in API mode (PRD §五.3): fetch /api/dashboard/weekly-review and render
   *  L1/L2/L3 with a period selector. When false/undefined, the legacy prop-
   *  driven render is used — the existing outer API is unchanged. */
  useApi?: boolean;
  /** Period mode (PRD §五.3 BFF-driven): caller passes pre-fetched L1/L2/L3
   *  (snake_case, grouped l3_by_user). Renders 6-tile L1 grid + expandable
   *  L2 sales table (9 cols) → L3 lead detail per owner. Mutually exclusive
   *  with useApi and the default prop-driven render. */
  mode?: "period";
  periodStart?: string;
  periodEnd?: string;
  range?: Period;
  onRangeChange?: (range: Period) => void;
  l1?: PeriodL1;
  l2?: PeriodL2Row[];
  l3_by_user?: Record<string, PeriodL3Row[]>;
}

const money = (value?: number) => `AED ${(value ?? 0).toLocaleString()}`;

export default function WeeklyReview(props: WeeklyReviewProps) {
  // PRD §五.3 period mode — caller-supplied L1/L2/l3_by_user. Renders the new
  // spec (6-tile L1, 9-col expandable L2, per-owner L3). No fetch, no effect on
  // the default prop-driven flow or the useApi fetch flow below.
  if (props?.mode === "period") {
    return (
      <WeeklyReviewPeriod
        language={props.language ?? "en"}
        periodStart={props.periodStart}
        periodEnd={props.periodEnd}
        range={props.range ?? "this_week"}
        onRangeChange={props.onRangeChange ?? (() => {})}
        l1={props.l1}
        l2={props.l2 ?? []}
        l3_by_user={props.l3_by_user ?? {}}
      />
    );
  }
  // PRD §五.3 API mode — opt-in via `useApi`. Legacy call sites that don't pass
  // it fall through to the original prop-driven render below.
  if (props?.useApi) {
    return <WeeklyReviewApi language={props.language ?? "en"} />;
  }
  const { month, finance = {} as FinanceStats, signingPct = null, collectionPct = null,
    signingTarget = 0, collectionTarget = 0, periodLeads = null, topActions = [],
    riskPoolCount = null, todayFollowups = [], overdueFollowups = [], redCount = 0,
    yellowCount = 0, highProbStale = 0, pendingStale = 0, recoveryCount = 0,
    transferCount = 0, reviewCount = 0, isLoading = false, language = "en" } = props ?? {} as WeeklyReviewProps;
  const locale = language === "zh" ? "zh" : "en";
  const i18n = (key: string): string => {
    const dict: Record<string, { zh: string; en: string }> = {
      bossTitle: { zh: "L1 老板 30 秒结论", en: "L1 Boss 30-Second Verdict" },
      execTitle: { zh: "L2 销售执行问题", en: "L2 Sales Execution Issues" },
      actionTitle: { zh: "L3 跟进风险/动作", en: "L3 Action Items & Risks" },
      contractAmount: { zh: "本月合同", en: "MTD Contracts" }, paymentAmount: { zh: "本月回款", en: "MTD Collections" },
      wonCount: { zh: "Won 数", en: "Won Count" }, overdue: { zh: "逾期", en: "Overdue" },
      red: { zh: "红 leads", en: "Red leads" }, yellow: { zh: "黄 leads", en: "Yellow leads" },
      highProbStale: { zh: "高概率停滞", en: "High-prob stale" }, pendingStale: { zh: "长期挂起", en: "Long-pending" },
      noData: { zh: "暂无数据", en: "No data yet" }, loading: { zh: "加载中…", en: "Loading…" },
      riskPool: { zh: "Risk Pool 待办", en: "Risk pool tasks" }, todayFollowups: { zh: "今日跟进", en: "Today's follow-ups" },
      topActions: { zh: "优先动作", en: "Top actions" }, leadQuality: { zh: "本月新 lead 质量", en: "MTD lead quality" },
      noTarget: { zh: "暂无月度目标，无法判定", en: "No monthly target set" }, leading: { zh: "进度领先", en: "On track" },
      oneSideLeading: { zh: "单边领先", en: "One-sided lead" }, lagging: { zh: "进度滞后", en: "Lagging" },
      recovery: { zh: "待回收", en: "To recover" }, transfer: { zh: "待转移", en: "To transfer" }, review: { zh: "待审", en: "To review" },
    };
    return dict[key]?.[locale] ?? key;
  };
  const now = new Date();
  const expectedPct = Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100);
  const allEmpty = signingTarget === 0 && collectionTarget === 0 && (finance.contractAmount ?? 0) === 0
    && (finance.paymentAmount ?? 0) === 0 && (finance.wonCount ?? 0) === 0 && (finance.overdue ?? 0) === 0
    && (periodLeads?.count ?? 0) === 0 && topActions.length === 0 && todayFollowups.length === 0
    && overdueFollowups.length === 0 && (riskPoolCount ?? 0) === 0 && redCount + yellowCount + highProbStale
    + pendingStale + recoveryCount + transferCount + reviewCount === 0;
  let verdict = i18n("noTarget");
  if (signingPct !== null && collectionPct !== null) {
    if (signingPct >= expectedPct && collectionPct >= expectedPct) verdict = locale === "zh" ? "进度领先 — 签收/收款 双超预期" : "On track — signing and collections exceed expectations";
    else if (signingPct >= expectedPct || collectionPct >= expectedPct) {
      const signingBetter = signingPct >= expectedPct;
      verdict = locale === "zh"
        ? `单边领先 — ${signingBetter ? "签收" : "收款"} 达标，${signingBetter ? "收款" : "签收"} 滞后`
        : `One-sided lead — ${signingBetter ? "signing" : "collections"} on track, ${signingBetter ? "collections" : "signing"} behind`;
    } else verdict = `${i18n("lagging")} — ${locale === "zh" ? "距月底预期差" : "month-end expectation gap"} ${Math.max(signingPct || 0, collectionPct || 0)}pp`;
  }
  const bars = <div className="space-y-3 py-2" aria-label={i18n("loading")}>
    <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
    <div className="h-4 w-full animate-pulse rounded bg-muted" />
    <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
    <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
  </div>;
  const title = (text: string, subtitle?: string) => <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">{text}</h2>{subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}</div>;
  const metric = (label: string, value: string | number) => <div className="rounded-lg border border-border/50 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="text-2xl font-bold">{value}</p></div>;
  const risk = (label: string, value: number, color: string) => <div className={`rounded-lg p-3 ${color}`}><p className="text-xs">{label}</p><p className="text-2xl font-bold">{value ?? 0}</p></div>;
  const actions = topActions?.slice(0, 3) ?? [];

  return <section className="space-y-4" aria-label={i18n("bossTitle")}>
    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      {title(i18n("bossTitle"), month)}
      {isLoading ? bars : <>
        <p className="mb-4 text-sm font-medium">{allEmpty ? (locale === "zh" ? "暂无足够数据生成周复盘" : "Not enough data for a weekly review") : verdict}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {metric(i18n("contractAmount"), money(finance.contractAmount))}
          {metric(i18n("paymentAmount"), money(finance.paymentAmount))}
          {metric(i18n("wonCount"), finance.wonCount ?? 0)}
          {metric(i18n("overdue"), money(finance.overdue))}
        </div>
      </>}
    </div>

    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      {title(i18n("execTitle"))}
      {isLoading ? bars : <>
        {periodLeads && (periodLeads.count ?? 0) > 0 ? <p className="mb-3 text-sm">{i18n("leadQuality")}: {periodLeads.count ?? 0}, good: {periodLeads?.byQuality?.good ?? 0}, normal: {periodLeads?.byQuality?.normal ?? 0}, pending: {periodLeads?.byQuality?.pending ?? 0}</p>
          : <p className="mb-3 text-sm text-muted-foreground">{i18n("noData")}</p>}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {risk(i18n("red"), redCount, "bg-red-500/10 text-red-400")}
          {risk(i18n("yellow"), yellowCount, "bg-amber-500/10 text-amber-400")}
          {risk(i18n("highProbStale"), highProbStale, "bg-amber-500/10 text-amber-400")}
          {risk(i18n("pendingStale"), pendingStale, "bg-amber-500/10 text-amber-400")}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{i18n("recovery")} {recoveryCount ?? 0} · {i18n("transfer")} {transferCount ?? 0} · {i18n("review")} {reviewCount ?? 0}</p>
      </>}
    </div>

    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      {title(i18n("actionTitle"))}
      {isLoading ? bars : <div className="space-y-3 text-sm">
        {riskPoolCount !== null && <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-emerald-400">📋 {i18n("riskPool")}: {riskPoolCount ?? 0} · {locale === "zh" ? "逾期跟进" : "Overdue follow-ups"}: {overdueFollowups.length}</div>}
        <div><p className="mb-1 font-medium">{i18n("todayFollowups")} ({todayFollowups.length})</p>
          {todayFollowups.length > 0 ? <ul className="space-y-1 text-muted-foreground">{todayFollowups.slice(0, 3).map((lead, index) => <li key={lead?.id ?? index}>{lead?.customer_name || (locale === "zh" ? "未命名客户" : "Unnamed customer")}</li>)}</ul>
            : <p className="text-muted-foreground">{locale === "zh" ? "今天无跟进" : "No follow-ups today"}</p>}</div>
        <div><p className="mb-1 font-medium">{i18n("topActions")}</p>
          {actions.length > 0 ? <ul className="space-y-1">{actions.map((action, index) => <li key={action?.leadId ?? index}><Link className="text-copper-400 hover:underline" href={action?.leadId ? `/leads/${action.leadId}` : "/leads"}>{action?.customerName || (locale === "zh" ? "未命名客户" : "Unnamed customer")}</Link><span className="text-muted-foreground"> · {action?.reason || i18n("noData")}</span></li>)}</ul>
            : <p className="text-muted-foreground">{i18n("noData")}</p>}</div>
        {allEmpty && <p className="text-muted-foreground">{i18n("noData")}</p>}
      </div>}
    </div>
  </section>;
}

// ════════════════════════════════════════════════════════════════════
// PRD §五.3 — API-driven WeeklyReview (opt-in via `useApi` prop)
// Fetches /api/dashboard/weekly-review?period=… and renders L1/L2/L3 with
// 本周 | 上周 | 本月 selector. Includes loading skeleton, error and empty states.
// ════════════════════════════════════════════════════════════════════
const PERIOD_OPTIONS: { value: Period; zh: string; en: string }[] = [
  { value: "this_week", zh: "本周", en: "This week" },
  { value: "last_week", zh: "上周", en: "Last week" },
  { value: "this_month", zh: "本月", en: "This month" },
];

function WeeklyReviewApi({ language }: { language: string }) {
  const locale = language === "zh" ? "zh" : "en";
  const [period, setPeriod] = useState<Period>("this_week");
  const [data, setData] = useState<WeeklyReviewApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);

  const fetchData = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/weekly-review?period=${p}`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) throw new Error(locale === "zh" ? "无权限" : "Forbidden");
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as WeeklyReviewApiResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => { fetchData(period); }, [period, fetchData]);

  const bars = <div className="space-y-3 py-2" aria-label={t("加载中…", "Loading…")}>
    <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
    <div className="h-4 w-full animate-pulse rounded bg-muted" />
    <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
    <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
  </div>;

  const l1 = data?.l1;
  const l2 = data?.l2 ?? [];
  const l3 = data?.l3 ?? [];
  const l1Empty = !!l1 && l1.newLeads === 0 && l1.contactedLeads === 0 && l1.qualityChecked === 0
    && l1.stageMoved === 0 && l1.won === 0 && l1.lost === 0;
  const metric = (label: string, value: number | string) => (
    <div className="rounded-lg border border-border/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );

  return <section className="space-y-4" aria-label={t("周复盘", "Weekly review")}>
    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
          {t("L1 公司本周概览", "L1 Company overview")}
        </h2>
        <div className="flex gap-1 rounded-lg border border-border/50 p-1">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.value} type="button" onClick={() => setPeriod(opt.value)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                period === opt.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}>
              {locale === "zh" ? opt.zh : opt.en}
            </button>
          ))}
        </div>
      </div>
      {loading ? bars : error ? (
        <p className="py-4 text-sm text-red-400">{t("加载失败：", "Failed to load: ")}{error}</p>
      ) : l1Empty ? (
        <p className="py-4 text-sm text-muted-foreground">{t("暂无数据", "No data yet")}</p>
      ) : <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {metric(t("新线索", "New leads"), l1?.newLeads ?? 0)}
          {metric(t("已联系", "Contacted"), l1?.contactedLeads ?? 0)}
          {metric(t("质检", "Quality checked"), l1?.qualityChecked ?? 0)}
          {metric(t("阶段推进", "Stage moved"), l1?.stageMoved ?? 0)}
          {metric(t("赢单", "Won"), l1?.won ?? 0)}
          {metric(t("输单", "Lost"), l1?.lost ?? 0)}
        </div>
      </>}
    </div>

    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-muted-foreground">
        {t("L2 销售明细", "L2 Per-sales breakdown")}
      </h2>
      {loading ? bars : error ? (
        <p className="py-2 text-sm text-muted-foreground">{t("暂无数据", "No data yet")}</p>
      ) : l2.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("暂无数据", "No data yet")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t("销售", "Sales")}</th>
                <th className="px-3 py-2 font-medium">{t("分配", "Assigned")}</th>
                <th className="px-3 py-2 font-medium">{t("已联系", "Contacted")}</th>
                <th className="px-3 py-2 font-medium">{t("待质检", "Pending QC")}</th>
                <th className="px-3 py-2 font-medium">{t("推进", "Moved")}</th>
                <th className="px-3 py-2 font-medium">{t("赢单", "Won")}</th>
                <th className="px-3 py-2 font-medium">{t("输单", "Lost")}</th>
                <th className="pl-3 py-2 font-medium">{t("逾期", "Overdue")}</th>
              </tr>
            </thead>
            <tbody>
              {l2.map(row => (
                <tr key={row.salesId} className="border-b border-border/30">
                  <td className="py-2 pr-3 font-medium">{row.salesName}</td>
                  <td className="px-3 py-2">{row.assigned}</td>
                  <td className="px-3 py-2">{row.contacted}</td>
                  <td className="px-3 py-2">{row.pendingQuality}</td>
                  <td className="px-3 py-2">{row.stageMoved}</td>
                  <td className="px-3 py-2 text-emerald-400">{row.won}</td>
                  <td className="px-3 py-2 text-muted-foreground">{row.lost}</td>
                  <td className="pl-3 py-2 text-red-400">{row.overdueTasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>

    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-muted-foreground">
        {t("L3 阶段变动明细", "L3 Moved leads")}
      </h2>
      {loading ? bars : error ? (
        <p className="py-2 text-sm text-muted-foreground">{t("暂无数据", "No data yet")}</p>
      ) : l3.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("暂无数据", "No data yet")}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {l3.map((row, i) => {
            const key = row.leadId ?? `row-${i}`;
            const name = row.leadName || (locale === "zh" ? "未命名客户" : "Unnamed");
            const inner = (
              <span className="text-copper-400 hover:underline">{name}</span>
            );
            return (
              <li key={key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {row.leadId ? (
                  <Link href={`/leads/${row.leadId}`}>{inner}</Link>
                ) : inner}
                <span className="text-muted-foreground">
                  · {t("负责人", "owner")}: {row.movedBy || "—"}
                  · {t("阶段", "stage")}: {row.currentStage ?? row.movedTo ?? "—"}
                  {row.lastContact && ` · ${t("上次联系", "last contact")}: ${new Date(row.lastContact).toLocaleDateString()}`}
                  {row.quality && ` · ${t("质量", "quality")}: ${row.quality}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  </section>;
}

// ════════════════════════════════════════════════════════════════════
// PRD §五.3 — Period-mode WeeklyReview (caller passes pre-fetched data).
// Renders L1 (6 metric tiles), L2 (9-col sales table, click row → expand
// L3 lead list per owner), with empty-state fallbacks. i18n zh/en inline.
// ════════════════════════════════════════════════════════════════════
function WeeklyReviewPeriod({
  language, periodStart, periodEnd, range, onRangeChange, l1, l2, l3_by_user,
}: {
  language: string;
  periodStart?: string;
  periodEnd?: string;
  range: Period;
  onRangeChange: (range: Period) => void;
  l1?: PeriodL1;
  l2: PeriodL2Row[];
  l3_by_user: Record<string, PeriodL3Row[]>;
}) {
  const locale = language === "zh" ? "zh" : "en";
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (uid: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  });

  const l1Empty = !l1 || (l1.new_leads === 0 && l1.contacted_leads === 0
    && l1.quality_judged === 0 && l1.stage_advanced === 0 && l1.won === 0 && l1.lost === 0);
  const l2Empty = l2.length === 0;
  const fmtDate = (iso?: string | null) => iso ? iso.slice(0, 10) : "—";

  const metric = (label: string, value: number | string) => (
    <div className="rounded-lg border border-border/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );

  return (
    <section className="space-y-4" aria-label={t("周复盘", "Weekly review")}>
      {/* L1 — 6 company metric tiles */}
      <div className="rounded-xl border border-border/50 bg-card/50 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            {t("L1 公司概览", "L1 Company overview")}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {(periodStart || periodEnd) && (
              <span className="text-xs text-muted-foreground">
                {periodStart ? fmtDate(periodStart) : "—"} → {periodEnd ? fmtDate(periodEnd) : "—"}
              </span>
            )}
            <div className="flex gap-1 rounded-lg border border-border/50 p-1">
              {PERIOD_OPTIONS.map(opt => (
                <button key={opt.value} type="button" onClick={() => onRangeChange(opt.value)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    range === opt.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}>
                  {locale === "zh" ? opt.zh : opt.en}
                </button>
              ))}
            </div>
          </div>
        </div>
        {l1Empty ? (
          <p className="py-4 text-sm text-muted-foreground">{t("暂无数据", "No data")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {metric(t("新线索", "New leads"), l1!.new_leads)}
            {metric(t("已联系", "Contacted"), l1!.contacted_leads)}
            {metric(t("质检", "Quality judged"), l1!.quality_judged)}
            {metric(t("阶段推进", "Stage advanced"), l1!.stage_advanced)}
            {metric(t("赢单", "Won"), l1!.won)}
            {metric(t("输单", "Lost"), l1!.lost)}
          </div>
        )}
      </div>

      {/* L2 — 9-col sales table, click row → expand L3 */}
      <div className="rounded-xl border border-border/50 bg-card/50 p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          {t("L2 销售明细", "L2 Per-sales breakdown")}
        </h2>
        {l2Empty ? (
          <p className="py-2 text-sm text-muted-foreground">{t("暂无数据", "No data")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t("销售", "Sales")}</th>
                  <th className="px-3 py-2 font-medium">{t("新线索", "New leads")}</th>
                  <th className="px-3 py-2 font-medium">{t("已联系", "Contacted")}</th>
                  <th className="px-3 py-2 font-medium">{t("待质检", "Pending QC")}</th>
                  <th className="px-3 py-2 font-medium">{t("推进", "Advanced")}</th>
                  <th className="px-3 py-2 font-medium">{t("赢单", "Won")}</th>
                  <th className="px-3 py-2 font-medium">{t("输单", "Lost")}</th>
                  <th className="px-3 py-2 font-medium">{t("逾期", "Overdue")}</th>
                  <th className="pl-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {l2.map(row => {
                  const isOpen = expanded.has(row.user_id);
                  const leads = l3_by_user[row.user_id] ?? [];
                  return (
                    <Fragment key={row.user_id}>
                      <tr
                        className="cursor-pointer border-b border-border/30 hover:bg-muted/30"
                        onClick={() => toggle(row.user_id)}
                      >
                        <td className="py-2 pr-3 font-medium">
                          {row.full_name || "—"}{" "}
                          <span className="text-xs text-muted-foreground">{isOpen ? "▼" : "▶"}</span>
                        </td>
                        <td className="px-3 py-2">{row.assigned_leads}</td>
                        <td className="px-3 py-2">{row.contacted}</td>
                        <td className="px-3 py-2">{row.pending_quality}</td>
                        <td className="px-3 py-2">{row.stage_advanced}</td>
                        <td className="px-3 py-2 text-emerald-400">{row.won}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.lost}</td>
                        <td className="px-3 py-2 text-red-400">{row.overdue_tasks}</td>
                        <td className="pl-3 py-2 text-xs text-muted-foreground">
                          {leads.length} {t("条", "leads")}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-muted/10">
                          <td colSpan={9} className="px-4 pb-3 pt-2">
                            {leads.length === 0 ? (
                              <p className="text-xs text-muted-foreground">{t("暂无数据", "No data")}</p>
                            ) : (
                              <ul className="space-y-2 text-xs">
                                {leads.map(lead => {
                                  const noteText = (lead.last_note ?? "").replace(/\s+/g, " ").trim();
                                  const truncated = noteText.length > 80 ? `${noteText.slice(0, 80)}…` : noteText;
                                  return (
                                    <li key={lead.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                      <Link href={`/leads/${lead.id}`} className="text-copper-400 hover:underline">
                                        {lead.customer_name || (locale === "zh" ? "未命名客户" : "Unnamed")}
                                      </Link>
                                      <span className="text-muted-foreground">
                                        · {t("阶段", "stage")}: {lead.stage ?? "—"}
                                        · {t("联系次数", "contacts")}: {lead.contact_count}
                                        {lead.quality && ` · ${t("质量", "quality")}: ${lead.quality}`}
                                        {` · ${t("上次联系", "last contact")}: ${fmtDate(lead.last_contact_date)}`}
                                        {lead.next_follow_up_at && ` · ${t("下次跟进", "next")}: ${fmtDate(lead.next_follow_up_at)}`}
                                      </span>
                                      {truncated && (
                                        <span className="max-w-[300px] truncate inline-block align-bottom text-muted-foreground">
                                          {`· ${t("备注", "note")}: ${truncated}`}
                                        </span>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
