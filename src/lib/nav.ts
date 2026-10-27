/**
 * Dashboard sidebar navigation configuration.
 *
 * Two role-scoped arrays are exported:
 *   - MGMT_NAV  → admin / boss / operator (12 items, includes ads, projects, team)
 *   - SALES_NAV → sales (9 items, includes workbench, payments)
 *
 * An item may narrow its audience further with `roles`, and one does: /team is
 * shown to admin and boss only, because src/app/actions/team.ts refuses every
 * other role, so an operator following that link would reach a page on which
 * nothing works. Call navForRole() rather than picking an array directly --
 * tests/security/nav-guard-coupling.test.mjs holds every item's audience to the
 * guard of the page it links to, and the acceptance runner's expected sidebar is
 * derived from this file.
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
  /** Roles this item is shown to. Absent means every role holding the array. */
  roles?: readonly string[];
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
  // admin/boss only: createTeamMember, updateTeamMember and deleteTeamMember in
  // src/app/actions/team.ts each refuse any other role, so operator would get a
  // page of buttons that all throw.
  { href: "/team",      labelKey: "mgmtTeam", icon: UsersRound, roles: ["admin", "boss"] },
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

/** Roles that hold MGMT_NAV. Mirrors the layout's own isManagement derivation. */
export const MANAGEMENT_ROLES: readonly string[] = ["admin", "boss", "operator"];

/**
 * The sidebar for a role, in order.
 *
 * One function so the sidebar, the tests and the acceptance runner's expectation
 * cannot disagree about which items a role sees. An unknown or absent role gets
 * the sales array, which is the narrower of the two.
 */
export function navForRole(role: string | null | undefined): NavItem[] {
  const base = role && MANAGEMENT_ROLES.includes(role) ? MGMT_NAV : SALES_NAV;
  return base.filter((item) => !item.roles || item.roles.includes(role ?? ""));
}
