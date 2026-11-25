"use client";

import Link from "next/link";
import { Menu, X, LogOut, ShieldCheck, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { LanguageToggle } from "@/components/LanguageToggle";
import { navForRole, primaryNavItems, moreNavItems, type NavItem } from "@/lib/nav";

/**
 * DashboardSidebar — DashboardLayout 左侧 sidebar (含 mobile hamburger + overlay)
 *
 * 100% 搬迁自 src/app/(dashboard)/layout.tsx 原 L42-146 区域 (步骤 4 后)。
 * 视觉 + 交互职责:
 *   - Mobile menu button (lg 隐藏, lg 以下 fixed top-3 left-3)
 *   - Mobile overlay backdrop (lg 隐藏, sidebar open 时盖黑半透)
 *   - <aside> sidebar 主体 (logo + LanguageToggle + role badge + nav list + footer user/logout/version)
 *
 * Props 直接透传 useAuthRedirect 的核心返回值 + layout 派生值 (pathname/isManagement/roleLabel):
 *   - pathname 从 usePathname() 来 (layout 注入, sidebar 不直接调 hook, 单一职责)
 *   - isManagement: layout 派生 (role === "admin" | "boss" | "operator"), 决定用 MGMT_NAV 还是 SALES_NAV
 *   - roleLabel: layout 派生 (i18n 翻译), 决定 role badge 文字 (避免 sidebar 内重复 useLanguage().t 调用)
 *   - role 决定 nav-loading fallback (role 未就绪时显示 "loading" 占位, 避免错误 nav flash)
 *   - userEmail + handleLogout: footer 用户卡片 + 登出按钮
 *
 * 注意:
 *   - 此组件自带 sidebarOpen state (mobile 控制), 与 layout 解耦
 *   - nav 配置 (MGMT_NAV/SALES_NAV) 在 sidebar 内 import, 不暴露给 layout
 *   - isItemActive 内联在 sidebar 内 (仅 sidebar 用, 不抽出)
 *   - "use client" 必加 (useState + Link onClick handler)
 */
interface DashboardSidebarProps {
  pathname: string;
  isManagement: boolean;
  roleLabel: string;
  userEmail: string | null;
  handleLogout: () => void | Promise<void>;
  role: string | null;
}

export function DashboardSidebar({
  pathname,
  isManagement,
  roleLabel,
  userEmail,
  handleLogout,
  role,
}: DashboardSidebarProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { t } = useLanguage();
  // navForRole owns both the array choice and the per-item narrowing (/team is
  // admin/boss, not every management role) so the sidebar cannot offer a link
  // the target page will bounce this role off.
  const nav = navForRole(role);
  // S41 (F16): sales see 6 primary items; the rest sit under a collapsed "More" that opens itself when the current page
  // is one of them.
  const primary = primaryNavItems(nav);
  const more = moreNavItems(nav);
  const moreActive = more.some((item) => pathname.startsWith(item.href));
  const [moreOpen, setMoreOpen] = useState(false);

  const isItemActive = (href: string) => {
    if (href === "/dashboard") return pathname === "/dashboard";
    if (href === "/workbench") return pathname === "/workbench";
    if (href === "/pipeline" && isManagement) return pathname.startsWith("/pipeline");
    if (href === "/pipeline" && !isManagement) return pathname.startsWith("/pipeline");
    return pathname.startsWith(href);
  };

  const renderItem = (item: NavItem) => {
    const ItemIcon = item.icon;
    const active = isItemActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        prefetch={false}
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
  };

  return (
    <>
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
              <p className="text-xs text-muted-foreground">
                {t("nav.platformTitle")}
              </p>
            </div>
            <LanguageToggle />
          </div>
          {/* Role badge */}
          <div className={cn(
            "mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
            isManagement
              ? "bg-slate-600/10 text-slate-700 border border-slate-600/20"
              : "bg-copper-500/10 text-copper-600 border border-copper-500/20"
          )}>
            <ShieldCheck className="w-3 h-3" />
            {roleLabel}
          </div>
        </div>

        <div className="h-px bg-border mx-3" />

        {/* Navigation — flat list; sales get a collapsed "More" group (S41) */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {!role ? (
            // Avoid flash of wrong nav while role is loading
            <div className="px-3 py-4 text-xs text-muted-foreground animate-pulse">{t("common.loading")}</div>
          ) : (
          <>
          {primary.map((item) => renderItem(item))}
          {more.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                data-testid="nav-more"
                aria-expanded={moreOpen || moreActive}
                onClick={() => setMoreOpen((v) => !v)}
                className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <ChevronDown className={cn("w-4 h-4 shrink-0 transition-transform", (moreOpen || moreActive) && "rotate-180")} />
                <span className="flex-1 truncate text-left">{t("nav.more")}</span>
              </button>
              {(moreOpen || moreActive) && (
                <div className="space-y-0.5 pl-2">
                  {more.map((item) => renderItem(item))}
                </div>
              )}
            </div>
          )}
          </>
          )}
        </nav>

        {/* Footer — user + logout */}
        <div className="p-3 border-t border-border space-y-2">
          {userEmail && (
            <div data-newme-uat-sensitive="true" className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <div className="w-6 h-6 rounded-full bg-slate-600/20 flex items-center justify-center text-slate-600 text-xs font-bold shrink-0">
                {userEmail.charAt(0).toUpperCase()}
              </div>
              <span className="truncate">{userEmail}</span>
            </div>
          )}
          <div className="flex justify-end px-2">
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-rose-700 transition-colors"
            >
              <LogOut className="w-3 h-3" />
              {t("nav.logout")}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
