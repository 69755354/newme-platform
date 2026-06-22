"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Users, Menu, X, Funnel,
  FileText, Calculator, CreditCard, TrendingUp,
  LogOut, ShieldCheck, Settings, Megaphone,
  Package, FolderKanban, UsersRound, Briefcase,
  BarChart3,
} from "lucide-react";
import { Toaster } from "sonner";
import { useState, useEffect, Suspense } from "react";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { createClient } from "@/lib/supabase";
import NotificationBell from "@/components/NotificationBell";

// ─── Nav item type ───
interface NavItem {
  href: string;
  labelKey: string;
  icon: React.ElementType;
}

// ─── Management nav — 5 core + settings ───
const MGMT_NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "mgmtDashboard", icon: LayoutDashboard },
  { href: "/leads",     labelKey: "mgmtLeads", icon: Users },
  { href: "/quotes",    labelKey: "mgmtQuotes", icon: Calculator },
  { href: "/contracts", labelKey: "mgmtContracts", icon: FileText },
  { href: "/pipeline",  labelKey: "mgmtPipeline", icon: Funnel },
  { href: "/analytics", labelKey: "mgmtAnalytics", icon: BarChart3 },
  { href: "/ads",       labelKey: "mgmtAds", icon: Megaphone },
  { href: "/products",  labelKey: "mgmtProducts", icon: Package },
  { href: "/team",      labelKey: "mgmtTeam", icon: UsersRound },
  { href: "/projects",  labelKey: "mgmtProjects", icon: Briefcase },
  { href: "/settings",  labelKey: "mgmtSettings", icon: Settings },
];

// ─── Sales nav — personal scope, 6 items ───
const SALES_NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "salesDashboard", icon: LayoutDashboard },
  { href: "/leads",     labelKey: "salesLeads", icon: Users },
  { href: "/quotes",    labelKey: "salesQuotes", icon: Calculator },
  { href: "/contracts", labelKey: "salesContracts", icon: FileText },
  { href: "/payments",  labelKey: "salesPayments", icon: CreditCard },
  { href: "/pipeline",  labelKey: "salesPipeline", icon: TrendingUp },
  { href: "/analytics", labelKey: "salesAnalytics", icon: BarChart3 },
  { href: "/products",  labelKey: "salesProducts", icon: Package },
];

// ─── Component ───

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { t, lang } = useLanguage();
  const [role, setRole] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Dev mode — auto sign-in to get valid JWT so RLS passes (production-safe: NODE_ENV guard)
    if (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_MODE === "true") {
      const DEV_EMAIL = process.env.DEV_EMAIL || "dev@newme.ae";
      const DEV_PASSWORD = process.env.DEV_PASSWORD || "dev123456";

      async function devLogin() {
        const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
          email: DEV_EMAIL,
          password: DEV_PASSWORD,
        });

        if (signInErr || !signInData.session) {
          // User missing or email not confirmed — call setup endpoint
          try {
            await fetch("/api/dev/setup", { method: "POST" });
            // Retry sign in after setup
            const { data: retryData, error: retryErr } = await supabase.auth.signInWithPassword({
              email: DEV_EMAIL,
              password: DEV_PASSWORD,
            });
            if (retryErr || !retryData.session) {
              setAuthError(true);
              setAuthLoading(false);
              return;
            }
            storeSession(retryData.session);
            return;
          } catch {
            setAuthError(true);
            setAuthLoading(false);
            return;
          }
        }
        storeSession(signInData.session);
      }

      function storeSession(_session: unknown) {
        // createBrowserClient (@supabase/ssr) manages the auth cookie itself
        // after signInWithPassword. We only update React state here — no manual
        // localStorage / document.cookie writes (those conflicted with the ssr
        // chunked-cookie refresh and caused intermittent session loss).
        void _session;
        setUserEmail(DEV_EMAIL);
        setRole("admin");
        setAuthLoading(false);
      }

      devLogin();
      return;
    }

    const t = setTimeout(() => {
      if (!cancelled) router.push("/login");
    }, 5000);
    supabase.auth.getUser().then(({ data: { user }, error }) => {
      clearTimeout(t);
      if (cancelled) return;
      if (error || !user) { router.push("/login"); return; }
      setUserEmail(user.email ?? null);
      supabase.from("profiles").select("role, force_password_change, full_name").eq("id", user.id).single()
        .then(({ data, error: profileErr }) => {
          if (cancelled) return;
          const r = data?.role ?? "sales";
          setRole(r);
          if (data?.force_password_change && pathname !== "/change-password") {
            router.push("/change-password");
          }
          setAuthLoading(false);
        });
    }).catch(() => {
      clearTimeout(t);
      if (!cancelled) { setAuthError(true); setAuthLoading(false); }
    });
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  const isManagement = role === "admin" || role === "boss" || role === "operator";
  const nav = isManagement ? MGMT_NAV : SALES_NAV;

  const isItemActive = (href: string) => {
    if (href === "/dashboard") return pathname === "/dashboard";
    if (href === "/pipeline" && isManagement) return pathname.startsWith("/pipeline");
    if (href === "/pipeline" && !isManagement) return pathname.startsWith("/pipeline"); 
    return pathname.startsWith(href);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    // Clear all auth storage from login page
    localStorage.removeItem("sb-vfopmpxlhwzpxqegayew-auth-token");
    const clearCookie = (name: string) => {
      document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
    };
    clearCookie("sb-vfopmpxlhwzpxqegayew-auth-token");
    clearCookie("sb-vfopmpxlhwzpxqegayew-refresh-token");
    clearCookie("sb-access-token");
    clearCookie("sb-refresh-token");
    router.push("/login");
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
            <div className="w-8 h-8 rounded-lg bg-wine-500 flex items-center justify-center font-bold text-foreground text-base">
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
              ? "bg-wine-500/10 text-wine-600 border border-wine-500/20"
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
                    ? "bg-wine-500/10 text-wine-600 font-medium border-l-[3px] border-wine-500 pl-2.5"
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
              <div className="w-6 h-6 rounded-full bg-wine-500/20 flex items-center justify-center text-wine-500 text-[10px] font-bold shrink-0">
                {userEmail.charAt(0).toUpperCase()}
              </div>
              <span className="truncate">{userEmail}</span>
            </div>
          )}
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              v2.3
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
              <div className="w-7 h-7 rounded-full bg-wine-500/20 flex items-center justify-center text-wine-500 text-xs font-bold">
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
        <div className="flex-1 p-6">
          {authLoading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              {t("common.loading")}
            </div>
          ) : authError ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <p className="text-rose-400 text-sm">Connection failed</p>
              <button onClick={() => window.location.reload()} className="text-xs text-wine-500 underline">Retry</button>
            </div>
          ) : (
            <Suspense
              fallback={<div className="flex items-center justify-center h-64 text-muted-foreground text-sm">{t("common.loading")}</div>}
            >
              {children}
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
