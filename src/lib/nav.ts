/**
 * Dashboard sidebar navigation configuration.
 *
 * Two role-scoped arrays are exported:
 *   - MGMT_NAV  → admin / boss / operator (12 items, includes command-center, ads, projects, team)
 *   - SALES_NAV → sales (8 items, includes workbench, payments)
 *
 * Icons are lucide-react components referenced via `icon` field. `ElementType`
 * lets us store the component class itself (React renders it lazily in layout.tsx).
 *
 * Used by src/app/(dashboard)/layout.tsx only — page.tsx files do not import
 * these arrays directly.
 *
 * @module nav
 */
import type { ElementType } from "react";
import {
  LayoutDashboard,
  Users,
  Funnel,
  FileText,
  Calculator,
  CreditCard,
  TrendingUp,
  Megaphone,
  Package,
  UsersRound,
  Briefcase,
  BarChart3,
  Swords,
  Settings,
} from "lucide-react";

export interface NavItem {
  href: string;
  labelKey: string;
  icon: ElementType;
}

// ─── Management nav — 5 core + settings ───
export const MGMT_NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "mgmtDashboard", icon: LayoutDashboard },
  { href: "/command-center", labelKey: "commandCenter", icon: Swords },
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

// ─── Sales nav — personal scope, 8 items ───
export const SALES_NAV: NavItem[] = [
  { href: "/workbench", labelKey: "salesWorkbench", icon: Briefcase },
  { href: "/leads",     labelKey: "salesLeads", icon: Users },
  { href: "/quotes",    labelKey: "salesQuotes", icon: Calculator },
  { href: "/contracts", labelKey: "salesContracts", icon: FileText },
  { href: "/payments",  labelKey: "salesPayments", icon: CreditCard },
  { href: "/pipeline",  labelKey: "salesPipeline", icon: TrendingUp },
  { href: "/analytics", labelKey: "salesAnalytics", icon: BarChart3 },
  { href: "/products",  labelKey: "salesProducts", icon: Package },
];