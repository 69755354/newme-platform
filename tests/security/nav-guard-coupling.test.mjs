/**
 * Every sidebar link must open for the role it is shown to.
 *
 * Measured 2026-08-20 by reading all eleven dashboard guards against the two nav
 * arrays: MGMT_NAV is rendered for admin, boss AND operator, yet /ads and /team
 * guarded on ["admin","boss"] and /analytics on ["admin","boss","sales"]. An
 * operator clicking any of those three was redirected straight back to
 * /dashboard -- three links that existed only to fail, on the sidebar of a role
 * that already administers the Admin Panel.
 *
 * Two of the three were the guard being wrong (both APIs answer operator), one
 * was the nav being wrong (/team's server actions are admin/boss only). Either
 * way the defect is that the two facts lived in different files with nothing
 * comparing them, so this file compares them: for each nav item, for each role
 * it is shown to, the guard of the page it links to must admit that role.
 *
 * Deliberately one-directional. A page may admit roles that are not shown the
 * link -- /contracts/[id] is reachable from a lead, /quotations/[id] from a quote
 * -- and requiring the converse would forbid that.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CONTRACT_READ_ROLES } from "../../src/lib/contract-access.mjs";
import { PAYMENT_PAGE_ROLES } from "../../src/lib/payment-idempotency.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NAV = readFileSync(path.join(ROOT, "src/lib/nav.ts"), "utf8");
const SIDEBAR = readFileSync(path.join(ROOT, "src/components/dashboard/DashboardSidebar.tsx"), "utf8");

/** Role lists a guard may reference by name instead of restating. */
const NAMED_ROLE_SETS = {
  CONTRACT_READ_ROLES: [...CONTRACT_READ_ROLES],
  PAYMENT_PAGE_ROLES: [...PAYMENT_PAGE_ROLES],
};

const MANAGEMENT_ROLES = ["admin", "boss", "operator"];
const ALL_ROLES = [...MANAGEMENT_ROLES, "sales"];

function navItems(arrayName) {
  const start = NAV.indexOf(`export const ${arrayName}: NavItem[] = [`);
  assert.ok(start >= 0, `${arrayName} not found`);
  const end = NAV.indexOf("\n];", start);
  assert.ok(end > start, `${arrayName} is not terminated`);
  return [...NAV.slice(start, end).matchAll(/\{\s*href:\s*"([^"]+)"([^}]*)\}/g)].map((match) => ({
    href: match[1],
    roles: /roles:\s*\[/.test(match[2])
      ? [...match[2].matchAll(/"([a-z_]+)"/g)].map((role) => role[1])
      : null,
  }));
}

/**
 * The roles a page admits, or null when it has no guard at all.
 *
 * A page with no useRequireRole call is open to every signed-in role -- the
 * layout has already required a session -- so there is nothing to compare.
 */
function guardRoles(href) {
  const file = path.join(ROOT, "src/app/(dashboard)", href.replace(/^\//, ""), "page.tsx");
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assert.fail(`${href} is in the sidebar but has no page at ${path.relative(ROOT, file)}`);
  }
  const spread = source.match(/useRequireRole\(\[\.\.\.([A-Z_]+)\]\)/);
  if (spread) {
    const roles = NAMED_ROLE_SETS[spread[1]];
    assert.ok(roles, `${href} guards on unknown constant ${spread[1]}`);
    return roles;
  }
  const literal = source.match(/useRequireRole\(\[([^\]]*)\]\)/);
  if (!literal) return null;
  return [...literal[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

test("the sidebar chooses its items through navForRole, not by picking an array", () => {
  assert.match(SIDEBAR, /const nav = navForRole\(role\)/);
  assert.doesNotMatch(SIDEBAR, /isManagement \? MGMT_NAV : SALES_NAV/);
  assert.match(NAV, /export function navForRole/);
});

test("every sidebar link opens for every role it is shown to", () => {
  const checked = [];
  for (const role of ALL_ROLES) {
    const items = navItems(MANAGEMENT_ROLES.includes(role) ? "MGMT_NAV" : "SALES_NAV")
      .filter((item) => !item.roles || item.roles.includes(role));
    assert.ok(items.length >= 8, `parsed only ${items.length} items for ${role}`);
    for (const item of items) {
      const admitted = guardRoles(item.href);
      if (admitted === null) continue;
      assert.ok(
        admitted.includes(role),
        `${role} is shown ${item.href} but its guard admits only ${admitted.join(", ")}`,
      );
      checked.push(`${role}:${item.href}`);
    }
  }
  // Negative control on the resolver: if guardRoles returned null everywhere the
  // loop above would assert nothing at all.
  assert.ok(checked.length >= 12, `only ${checked.length} guarded links were actually compared`);
});

test("the pages whose server side refuses operator do not appear in operator's sidebar", () => {
  // /team is the one nav item narrowed by `roles`, because createTeamMember,
  // updateTeamMember and deleteTeamMember all refuse anything but admin/boss.
  const actions = readFileSync(path.join(ROOT, "src/app/actions/team.ts"), "utf8");
  assert.match(actions, /\['admin', 'boss'\]\.includes\(role\)/);

  const operator = navItems("MGMT_NAV")
    .filter((item) => !item.roles || item.roles.includes("operator"))
    .map((item) => item.href);
  assert.ok(!operator.includes("/team"), "operator is still offered /team");
  for (const role of ["admin", "boss"]) {
    const shown = navItems("MGMT_NAV")
      .filter((item) => !item.roles || item.roles.includes(role))
      .map((item) => item.href);
    assert.ok(shown.includes("/team"), `${role} lost /team`);
  }
});
