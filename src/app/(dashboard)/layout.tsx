"use client";

import { usePathname } from "next/navigation";
import { Toaster } from "sonner";
import { Suspense, useSyncExternalStore } from "react";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useAuthRedirect } from "@/hooks/useAuthRedirect";
import { useVersionSkewReload } from "@/hooks/useVersionSkewReload";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { ConnectionFailed } from "@/components/ConnectionFailed";
import { isSessionUnavailable, subscribeSessionUnavailable } from "@/lib/session-identity";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";

// ─── Component ───

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useLanguage();
  const { role, userEmail, authLoading, authError, handleLogout } = useAuthRedirect();
  useVersionSkewReload();
  // Published by src/lib/session-identity.ts when any page's session read stays
  // unavailable after its retries: the page would otherwise sit on "loading"
  // with no way out, so the layout shows the shared connection-failed view.
  const sessionUnavailable = useSyncExternalStore(subscribeSessionUnavailable, isSessionUnavailable, () => false);

  const isManagement = role === "admin" || role === "boss" || role === "operator";

  const roleLabel = isManagement
    ? t("nav.roleManagement")
    : t("nav.roleSales");

  return (
    <>
    <div className="h-dvh bg-background text-foreground flex overflow-hidden print:h-auto print:overflow-visible">
      <DashboardSidebar
        pathname={pathname}
        isManagement={isManagement}
        roleLabel={roleLabel}
        userEmail={userEmail}
        handleLogout={handleLogout}
        role={role}
      />

      {/* Main content */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Top header bar — user info always visible */}
        {(role || authError) && (
          <DashboardTopBar
            role={role}
            userEmail={userEmail}
            authError={authError}
            handleLogout={handleLogout}
          />
        )}
        {/*
          T2-1 (Taskboard): 统一滚动策略 — page-scroll container.

          此 div 是 dashboard 滚动边界 (overflow-hidden). 子页面应当:
            - 在根 div 使用 `h-full` 配合 `<DashboardScrollContainer>` (推荐)
              或 `useDashboardScroll()` hook — 让内部滚动继承父级高度
            - 禁止使用 min-h-screen / 100vh / calc(100vh - Xpx)
            - 禁止在根 div 声明 overflow-y-scroll (会和这里冲突)

          父级 chain: main (flex-1) → header (固定高) → 本 div (flex-1) → 页面
        */}
        <div className="flex-1 min-h-0 p-6 min-w-0 overflow-hidden" data-dashboard-scroll-boundary="">
          <div className="h-full flex flex-col">
          {authLoading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              {t("common.loading")}
            </div>
          ) : authError || sessionUnavailable ? (
            <ConnectionFailed />
          ) : (
            <Suspense
              fallback={<div className="flex items-center justify-center h-64 text-muted-foreground text-sm">{t("common.loading")}</div>}
            >
              <DashboardErrorBoundary>
                {children}
              </DashboardErrorBoundary>
            </Suspense>
          )}
          </div>
        </div>
      </main>
    </div>
    <Toaster position="top-center" richColors />
    </>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <DashboardLayoutInner>{children}</DashboardLayoutInner>
    </LanguageProvider>
  );
}