"use client";

import { createContext, useContext, useMemo } from "react";
import dynamic from "next/dynamic";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLanguage } from "@/lib/i18n/context";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import LeadHealth from "./_components/LeadHealth";
import PipelineFunnel from "./_components/PipelineFunnel";
import PaymentTracker from "./_components/PaymentTracker";
import AdsROI from "./_components/AdsROI";
import { PageIdentityContext } from "@/lib/session-contexts";

const SalesLoad = dynamic(() => import("./_components/SalesLoad"), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse bg-muted/20 rounded-lg" />,
});

const WeeklyTrends = dynamic(() => import("./_components/WeeklyTrends"), {
  ssr: false,
  loading: () => <div className="h-80 animate-pulse bg-muted/20 rounded-lg" />,
});

/* ─── Shared analytics data context ─── */
interface AnalyticsSummary {
  profile: { userId: string; role: string };
  leadHealth: any;
  pipelineFunnel: any;
  paymentTracker: any;
  adsRoi: any;
  salesLoad: any;
  weeklyTrends: any;
}

const AnalyticsContext = createContext<AnalyticsSummary | null>(null);
export function useAnalyticsData() {
  return useContext(AnalyticsContext);
}

export default function AnalyticsPage() {
  // operator included: /api/analytics/summary computes isManagement as
  // ["admin","boss","operator"], so the server already serves this role the
  // management view the sidebar sends them to.
  const { loading: roleLoading, blocked, role, userId } = useRequireRole(["admin", "boss", "operator", "sales"]);
  const { t } = useLanguage();

  // S22: the panels below each used to ask the server who the user is again
  // (five /api/auth/me calls, one after the other). The role is resolved once,
  // here, and the panels read it from context.
  const pageIdentity = useMemo(
    () => (role ? { role, userId } : null),
    [role, userId],
  );

  // S22: this page used to fetch /api/analytics/summary as well, the slowest
  // call on the page, and then nothing read the result: every panel loads its
  // own endpoint. The call is gone; the route stays for its other callers.
  const analyticsData: AnalyticsSummary | null = null;

  // Block render until role is resolved to prevent flash
  if (roleLoading || blocked || !pageIdentity) return null;

  const isManagement = role === "boss" || role === "admin";
  const isSales = role === "sales";

  if (isManagement) {
    /* ═══ CEO/Admin View: 2-column grid ═══ */
    return (
      <PageIdentityContext.Provider value={pageIdentity}>
      <AnalyticsContext.Provider value={analyticsData}>
        <DashboardScrollContainer className="space-y-5">
          {/* Header */}
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">
              {t("analytics.title")}
            </h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              {t("analytics.subtitle")}
            </p>
          </div>

          {/* Row 1: Lead Health + Sales Load */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-xl border border-border/50 bg-card/50 p-4">
              <LeadHealth />
            </div>
            <div className="rounded-xl border border-border/50 bg-card/50 p-4">
              <SalesLoad />
            </div>
          </div>

          {/* Row 2: Pipeline Funnel (full width) */}
          <PipelineFunnel />

          {/* Row 3: Payment Tracking + Ads ROI */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <PaymentTracker />
            <div className="rounded-xl border border-border/50 bg-card/50 p-4">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-4 rounded-full bg-copper-400" />
                <h2 className="text-sm font-semibold text-foreground">{t("analytics.adsROI")}</h2>
              </div>
              <AdsROI />
            </div>
          </div>

          {/* Row 4: Weekly Trends (full width) */}
          <WeeklyTrends isManagement={true} />
        </DashboardScrollContainer>
      </AnalyticsContext.Provider>
      </PageIdentityContext.Provider>
    );
  }

  /* ═══ Sales View: Single column, action-first ═══ */
  return (
    <PageIdentityContext.Provider value={pageIdentity}>
      <AnalyticsContext.Provider value={analyticsData}>
      <DashboardScrollContainer className="space-y-5 max-w-3xl">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">
            {t("analytics.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {t("analytics.subtitleSales")}
          </p>
        </div>

        {/* Slot 1: Lead Health (includes overdue action list at top) */}
        <div className="rounded-xl border border-border/50 bg-card/50 p-4">
          <LeadHealth />
        </div>

        {/* Slot 2: My Sales Load */}
        <div className="rounded-xl border border-border/50 bg-card/50 p-4">
          <SalesLoad />
        </div>

        {/* Slot 3: My Pipeline Funnel */}
        <PipelineFunnel />

        {/* Slot 4: My Payment Tasks */}
        <PaymentTracker />

        {/* Slot 5: My Weekly Trends */}
        <WeeklyTrends isManagement={false} />
      </DashboardScrollContainer>
    </AnalyticsContext.Provider>
      </PageIdentityContext.Provider>
  );
}
