"use client";

import { LogOut } from "lucide-react";
import NotificationBell from "@/components/NotificationBell";
import { useLanguage } from "@/lib/i18n/LanguageContext";

/**
 * DashboardTopBar — DashboardLayout 顶部 header bar
 *
 * 100% 搬迁自 src/app/(dashboard)/layout.tsx 原 L150-174 区域 (步骤 2 后).
 * 视觉 + 交互职责:
 *   - authError 时的 "Connection error — tap to retry" 按钮 (window.location.reload)
 *   - NotificationBell (通知中心)
 *   - 用户头像 (email 首字母) + email + roleLabel
 *   - 右侧 logout icon 按钮
 *
 * Props 直接透传 useAuthRedirect 的返回值,业务逻辑 100% 等价:
 *   - role 决定 roleLabel (管理端 = nav.roleManagement, 销售端 = nav.roleSales)
 *   - role === "admin" | "boss" | "operator" 视为管理端
 *   - t (i18n) 内部从 useLanguage 取 (与 Sidebar 内的 LanguageToggle 行为一致 —
 *     TopBar 必须在 LanguageProvider 子代,layout 已确保)
 *   - handleLogout 直接转发 useAuthRedirect 的 signOut + 清 cookie + push /login
 *
 * 注意:
 *   - 此组件在 <main> 内但在滚动 div (data-dashboard-scroll-boundary) **外**,
 *     不被 ErrorBoundary 包 (T1-5 验收铁律仅要求包 children,header 错误不 crash 布局)
 *   - 只在 (role || authError) 为真时由 layout 渲染,自身不做条件
 */
interface DashboardTopBarProps {
  role: string | null;
  userEmail: string | null;
  authError: boolean;
  handleLogout: () => void | Promise<void>;
}

export function DashboardTopBar({
  role,
  userEmail,
  authError,
  handleLogout,
}: DashboardTopBarProps) {
  const { t } = useLanguage();

  const isManagement = role === "admin" || role === "boss" || role === "operator";
  const roleLabel = isManagement ? t("nav.roleManagement") : t("nav.roleSales");

  return (
    <div className="flex items-center justify-end gap-3 px-6 py-2.5 border-b border-border/50 bg-background/80 backdrop-blur-sm sticky top-0 z-30">
      {authError && (
        <button
          onClick={() => window.location.reload()}
          className="text-xs text-rose-400 hover:text-rose-300 mr-2"
        >
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
      <button
        onClick={handleLogout}
        className="text-[10px] text-muted-foreground hover:text-rose-400 transition-colors px-2 py-1 rounded hover:bg-accent"
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}