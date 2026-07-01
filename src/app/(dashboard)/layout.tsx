"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Menu, X, LogOut, ShieldCheck } from "lucide-react";
import { Toaster } from "sonner";
import { useState, Suspense } from "react";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useAuthRedirect } from "@/hooks/useAuthRedirect";
import NotificationBell from "@/components/NotificationBell";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { MGMT_NAV, SALES_NAV } from "@/lib/nav";

// ─── Component ───

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { t, lang } = useLanguage();
  const { role, userEmail, authLoading, authError, handleLogout } = useAuthRedirect();

  const isManagement = role === "admin" || role === "boss" || role === "operator";
  const nav = isManagement ? MGMT_NAV : SALES_NAV;

  const isItemActive = (href: string) => {
    if (href === "/dashboard") return pathname === "/dashboard";
    if (href === "/workbench") return pathname === "/workbench";
    if (href === "/pipeline" && isManagement) return pathname.startsWith("/pipeline");
    if (href === "/pipeline" && !isManagement) return pathname.startsWith("/pipeline");
    return pathname.startsWith(href);
  };

  const roleLabel = isManagement
    ? t("nav.roleManagement")
    : t("nav.roleSales");

  return (
    <>
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Mobile menu button */}
      <button
        className="fixed top-3 left-3 z-50 lg:hidden p-2 rounded-lg bg-accent text-muted-foreground"
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 z-40 w-64 bg-sidebar border-r border-border flex flex-col transition-transform",
          "overflow-y-auto",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Logo + role badge */}
        <div className="p-5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-600 flex items-center justify-center font-bold text-foreground text-base">
              N
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-foreground truncate">NewMe</p>
              <p className="text-[11px] text-muted-foreground">
                {t("nav.platformTitle")}
              </p>
            </div>
            <LanguageToggle />
          </div>
          {/* Role badge */}
          <div className={cn(
            "mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium",
            isManagement
              ? "bg-slate-600/10 text-slate-700 border border-slate-600/20"
              : "bg-copper-500/10 text-copper-600 border border-copper-500/20"
          )}>
            <ShieldCheck className="w-3 h-3" />
            {roleLabel}
          </div>
        </div>

        <div className="h-px bg-border mx-3" />

        {/* Navigation — flat list, no groups */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {!role ? (
            // Avoid flash of wrong nav while role is loading
            <div className="px-3 py-4 text-xs text-muted-foreground animate-pulse">{t("common.loading")}</div>
          ) : (
          nav.map((item) => {
            const ItemIcon = item.icon;
            const active = isItemActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
                  active
                    ? "bg-slate-600/10 text-slate-700 font-medium border-l-[3px] border-slate-600 pl-2.5"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
              >
                <ItemIcon className="w-4 h-4 shrink-0" />
                <span className="flex-1 truncate">
{t(`nav.${item.labelKey}`)}
                </span>
              </Link>
            );
          })
          )}
        </nav>

        {/* Footer — user + logout */}
        <div className="p-3 border-t border-border space-y-2">
          {userEmail && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
              <div className="w-6 h-6 rounded-full bg-slate-600/20 flex items-center justify-center text-slate-600 text-[10px] font-bold shrink-0">
                {userEmail.charAt(0).toUpperCase()}
              </div>
              <span className="truncate">{userEmail}</span>
            </div>
          )}
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              v{process.env.NEXT_PUBLIC_APP_VERSION || "dev"}
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-rose-400 transition-colors"
            >
              <LogOut className="w-3 h-3" />
              {t("nav.logout")}
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Top header bar — user info always visible */}
        {(role || authError) && (
          <div className="flex items-center justify-end gap-3 px-6 py-2.5 border-b border-border/50 bg-background/80 backdrop-blur-sm sticky top-0 z-30">
            {authError && (
              <button onClick={() => window.location.reload()} className="text-xs text-rose-400 hover:text-rose-300 mr-2">
                Connection error — tap to retry
              </button>
            )}
            {/* Notification bell */}
            <NotificationBell />
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-slate-600/20 flex items-center justify-center text-slate-600 text-xs font-bold">
                {userEmail ? userEmail.charAt(0).toUpperCase() : "?"}
              </div>
              <div className="text-right">
                <p className="text-xs font-medium text-foreground leading-tight">{userEmail || "..."}</p>
                <p className="text-[10px] text-muted-foreground leading-tight">{roleLabel}</p>
              </div>
            </div>
            <button onClick={handleLogout}
              className="text-[10px] text-muted-foreground hover:text-rose-400 transition-colors px-2 py-1 rounded hover:bg-accent">
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
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
        <div className="flex-1 p-6 min-w-0 overflow-hidden" data-dashboard-scroll-boundary="">
          {authLoading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              {t("common.loading")}
            </div>
          ) : authError ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <p className="text-rose-400 text-sm">Connection failed</p>
              <button onClick={() => window.location.reload()} className="text-xs text-slate-600 underline">Retry</button>
            </div>
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
