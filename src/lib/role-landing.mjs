// S43 (F08): where each role lands after sign-in, and how the top bar names the role.
// Finance and designers used to be sent to the sales workbench ("Sales Workbench", "New Lead",
// top bar "Sales"). The sidebar (src/lib/nav.ts) already knows which pages admit them; this is the
// matching landing page and label. Management (admin, boss, operator) stays on /dashboard.
export const MANAGEMENT_ROLES = Object.freeze(["admin", "boss", "operator"]);

/** The page a signed-in role should see first. Unknown or missing roles land like sales. */
export function landingPathForRole(role) {
  switch (role) {
    case "admin":
    case "boss":
    case "operator":
      return "/dashboard";
    case "finance":
      return "/contracts";
    case "designer":
      return "/projects";
    default:
      return "/workbench";
  }
}

/** The translation key of the role label shown next to the account (nav.*). */
export function roleLabelKey(role) {
  if (MANAGEMENT_ROLES.includes(role)) return "nav.roleManagement";
  if (role === "finance") return "nav.roleFinance";
  if (role === "designer") return "nav.roleDesigner";
  return "nav.roleSales";
}
