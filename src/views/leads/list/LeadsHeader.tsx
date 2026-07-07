"use client";

/**
 * LeadsHeader — T3-3 step 8 extracted from leads/page.tsx (was L237-275)
 *
 * Two-region header strip for the leads dashboard. Returns a React
 * Fragment so the page-level DOM stays identical to the pre-refactor
 * shape:
 *   1. <SubNavTabs/>                 ← lives OUTSIDE DashboardScrollContainer
 *   2. <div data-sticky="page-title"> ← lives INSIDE DashboardScrollContainer
 *
 * Why Fragment (not a wrapper div)?
 *   - page.tsx wraps the whole page in <div className="space-y-0"> which
 *     establishes the vertical rhythm between SubNavTabs (top) and
 *     DashboardScrollContainer (below). Wrapping the two regions in a
 *     new <div> would either:
 *       (a) break the space-y-0 chain, or
 *       (b) require moving SubNavTabs INSIDE the ScrollContainer, which
 *           would change the sticky-positioning context for page-title
 *           (currently inside the inner scroll, where sticky top-0 works
 *           relative to DashboardScrollContainer's overflow).
 *   - Fragment has no DOM impact, so the parent layout is byte-identical.
 *
 * 100% behavioural equivalence with the inline JSX that lived in page.tsx:
 *   - data-sticky-region="page-title" preserved on the wrapping div
 *   - buttons still mutate parent state via the passed setters (no local
 *     state — this component is a pure presentational shell)
 *   - sticky offset matches the old markup exactly (top-0 z-20 + 95%
 *     backdrop-blur-sm + -mx-4 px-4 py-2)
 *
 * Why extract this even though it has no state of its own?
 *   - leads/page.tsx is shrinking toward a render-only orchestrator
 *   - SubNavTabs + page-title is a coherent UX unit (always paired, top
 *     of the page); future tweaks (A/B labels, action button variants)
 *     become local instead of touching the 512-line page
 *
 * Props are passed-through by design (no internal state). All setters
 * are dispatched to the page so existing state remains the single
 * source of truth.
 */

import { Fragment } from "react";
import { Plus, TrendingUp, Upload } from "lucide-react";
import SubNavTabs from "@/views/layout/SubNavTabs";
import { useLanguage } from "@/views/i18n/LanguageContext";
import { fmtAED } from "@/views/leads/utils/format";

/* ─── Props ─── */
export interface LeadsHeaderProps {
  activeCount: number;
  totalPipeline: number;
  showPipelineSummary: boolean;
  setShowPipelineSummary: (v: boolean | ((prev: boolean) => boolean)) => void;
  setShowQuickCreate: (v: boolean | ((prev: boolean) => boolean)) => void;
  setShowImport: (v: boolean | ((prev: boolean) => boolean)) => void;
}

/* ─── Component ─── */
export function LeadsHeader({
  activeCount,
  totalPipeline,
  showPipelineSummary,
  setShowPipelineSummary,
  setShowQuickCreate,
  setShowImport,
}: LeadsHeaderProps) {
  const { t } = useLanguage();

  return (
    <Fragment>
      <SubNavTabs
        items={[
          { href: "/leads", labelKey: "leads.subnavAllLeads", iconName: "users" },
          { href: "/ads", labelKey: "leads.subnavAdAnalytics", iconName: "megaphone" },
        ]}
      />
      {/* T2-4: 锚定功能卡片 — 整页滚动时关键控件可见
          DashboardScrollContainer 建立 inner scroll 上下文，sticky 元素
          (page-title z-20 / filter-bar z-10) 才能正确锚定。 */}
      {/* page-title sticky: h1 + 顶部操作按钮 (Pipeline overview / Create / Import)
          永远可见 — 用户滚到底部也知道自己在 leads 列表 */}
      <div
        data-sticky-region="page-title"
        className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b -mx-4 px-4 py-2"
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">{t("leads.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">{t("leads.activePipeline").replace("{count}", String(activeCount)).replace("{value}", fmtAED(totalPipeline) || "—")}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowPipelineSummary(!showPipelineSummary)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <TrendingUp className="w-3.5 h-3.5" />{t("leads.pipelineOverview")}
            </button>
            <button onClick={() => setShowQuickCreate(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/85 transition-colors">
              <Plus className="w-3.5 h-3.5" />{t("common.create")}
            </button>
            <button onClick={() => setShowImport(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <Upload className="w-3.5 h-3.5" />{t("leads.importBtn")}
            </button>
          </div>
        </div>
      </div>
    </Fragment>
  );
}