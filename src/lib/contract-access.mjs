/**
 * Who may read contracts, declared once.
 *
 * Measured on production 2026-08-20 with the acceptance credentials: an operator
 * and a sales user both received `GET /api/contracts -> 200`, and both were
 * bounced off /contracts by the page itself (operator to /dashboard, sales to
 * /workbench) within four seconds of arriving. The page guard read
 * `useRequireRole(["admin", "boss"])` while the route it reads from admits five
 * roles and the detail page admits the same five — three declarations of one
 * boundary, and the narrowest of them was the one employees actually hit. Sales
 * could open a single contract by URL but never see the list it links from.
 *
 * The authority behind the list is not any of those arrays: it is the RLS SELECT
 * policies on public.contracts, which admit admin/boss/operator and finance to
 * every row and sales to rows where `sales_id = auth.uid()`. So the five roles
 * below are the roles the database will actually return rows to, the routes
 * refuse everyone else explicitly rather than serving an empty list that looks
 * like "no contracts yet", and sales narrowing stays in the routes because it is
 * a row filter, not a role check.
 *
 * tests/security/contract-read-access.test.mjs recomputes this set from the
 * migration SQL and asserts all four call sites reference this constant, so the
 * next role added to a policy cannot leave a page behind.
 *
 * A .mjs module rather than a .ts one for the same reason as
 * src/lib/payment-idempotency.mjs: node --test imports it directly, without a
 * build step, so the test checks the value the app ships instead of a copy of it.
 */

/** Every role that may open a contracts page; sales is narrowed to owned rows. */
export const CONTRACT_READ_ROLES = Object.freeze([
  "admin",
  "boss",
  "sales",
  "finance",
  "operator",
]);

/** Roles that see every contract row. Sales is deliberately absent. */
export const CONTRACT_READ_ALL_ROLES = Object.freeze(
  CONTRACT_READ_ROLES.filter((role) => role !== "sales"),
);

/**
 * True when `role` may read contracts at all.
 *
 * Kept as a function so the routes express the check the same way and a future
 * conditional role cannot be added by one caller only.
 */
export function canReadContracts(role) {
  return typeof role === "string" && CONTRACT_READ_ROLES.includes(role);
}

/** True when the role's list must be filtered to `sales_id = user.id`. */
export function contractsScopedToOwner(role) {
  return role === "sales";
}
