/**
 * Dashboard sidebar navigation configuration.
 *
 * Two role-scoped arrays are exported:
 *   - MGMT_NAV  → admin / boss / operator (12 items, includes ads, projects, team)
 *   - SALES_NAV → sales (9 items, includes workbench, payments)
 *
 * An entry that must be visible to EVERY signed-in role has to appear in both
 * arrays — the sidebar renders exactly one of them.
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
  Settings,
  Cable,
} from "lucide-react";

export interface NavItem {
  href: string;
  labelKey: string;
  icon: ElementType;
}

// ─── Management nav — 5 core + settings ───
export const MGMT_NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "mgmtDashboard", icon: LayoutDashboard },
  { href: "/leads",     labelKey: "mgmtLeads", icon: Users },
  { href: "/quotes",    labelKey: "mgmtQuotes", icon: Calculator },
  // Cable & pulling-labour costing is an employee self-service tool with no role
  // filter, so it appears in BOTH arrays — the sidebar shows exactly one of them
  // (MGMT_NAV for admin/boss/operator, SALES_NAV for sales), so a single entry
  // would hide the page from half the staff. `Cable` rather than `Calculator`:
  // /quotes already owns the calculator glyph.
  { href: "/cable-costing", labelKey: "cableCosting", icon: Cable },
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
  { href: "/cable-costing", labelKey: "cableCosting", icon: Cable },
  { href: "/contracts", labelKey: "salesContracts", icon: FileText },
  { href: "/payments",  labelKey: "salesPayments", icon: CreditCard },
  { href: "/pipeline",  labelKey: "salesPipeline", icon: TrendingUp },
  { href: "/analytics", labelKey: "salesAnalytics", icon: BarChart3 },
  { href: "/products",  labelKey: "salesProducts", icon: Package },
];