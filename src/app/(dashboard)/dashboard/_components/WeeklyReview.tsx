import Link from "next/link";

interface FinanceStats {
  totalContractValue: number; received: number; outstanding: number;
  overdue: number; dueNextWeek: number; contractCount?: number;
  contractAmount?: number; paymentAmount?: number; wonCount?: number;
}
interface TopAction { customerName?: string; reason?: string; leadId?: string; }
interface Lead { id?: string; customer_name?: string | null; }
interface WeeklyReviewProps {
  period: string; finance: FinanceStats; signingPct: number | null; collectionPct: number | null;
  signingTarget: number; collectionTarget: number;
  periodLeads: { count: number; byQuality: Record<string, number>; bySource: Record<string, number> } | null;
  topActions: TopAction[]; riskPoolCount: number | null; todayFollowups: Lead[]; overdueFollowups: any[];
  redCount: number; yellowCount: number; highProbStale: number; pendingStale: number;
  recoveryCount: number; transferCount: number; reviewCount: number; isLoading: boolean; language: string;
}

const money = (value?: number) => `AED ${(value ?? 0).toLocaleString()}`;

export default function WeeklyReview(props: WeeklyReviewProps) {
  const { period, finance = {} as FinanceStats, signingPct = null, collectionPct = null,
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
      {title(i18n("bossTitle"), period)}
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
