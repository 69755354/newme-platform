"use client";

import dynamic from "next/dynamic";
import { ErrorState } from "@/components/ui/error-state";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLanguage } from "@/lib/i18n/context";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import LeadHealth from "./_components/LeadHealth";
import PipelineFunnel from "./_components/PipelineFunnel";
import PaymentTracker from "./_components/PaymentTracker";
import AdsROI from "./_components/AdsROI";

const SalesLoad = dynamic(() => import("./_components/SalesLoad"), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse bg-muted/20 rounded-lg" />,
});

const WeeklyTrends = dynamic(() => import("./_components/WeeklyTrends"), {
  ssr: false,
  loading: () => <div className="h-80 animate-pulse bg-muted/20 rounded-lg" />,
});

export default function AnalyticsPage() {
  const { loading: roleLoading, blocked, role } = useRequireRole(["admin", "boss", "sales"]);
  const { t } = useLanguage();

  // Block render until role is resolved to prevent flash
  if (roleLoading || blocked) return null;

  const isManagement = role === "boss" || role === "admin";
  const isSales = role === "sales";

  if (isManagement) {
    /* ═══ CEO/Admin View: 2-column grid ═══ */
    return (
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
    );
  }

  /* ═══ Sales View: Single column, action-first ═══ */
  return (
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
  );
}
