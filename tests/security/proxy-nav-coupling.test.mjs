/**
 * S10: every sidebar link must pass the proxy's PROTECTED_ROUTES gate too.
 *
 * Found by the S9 staging regression run: SALES_NAV offers /pipeline, but
 * src/proxy.ts admitted only admin/boss/operator to it, so a salesperson who
 * clicked the link was bounced to the workbench. nav-guard-coupling.test.mjs
 * compares the nav with each page's own guard; this compares it with the proxy,
 * the other place that can refuse a page.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NAV = readFileSync(path.join(ROOT, "src/lib/nav.ts"), "utf8");
const PROXY = readFileSync(path.join(ROOT, "src/proxy.ts"), "utf8");

const ARRAY_FOR_ROLE = { admin: "MGMT_NAV", boss: "MGMT_NAV", operator: "MGMT_NAV", sales: "SALES_NAV", finance: "FINANCE_NAV", designer: "DESIGNER_NAV" };

function protectedRoutes() {
  const start = PROXY.indexOf("const PROTECTED_ROUTES");
  const end = PROXY.indexOf("};", start);
  assert.ok(start >= 0 && end > start, "PROTECTED_ROUTES not found in proxy.ts");
  const body = PROXY.slice(start, end).replace(/\/\/.*$/gm, "");
  return Object.fromEntries(
    [...body.matchAll(/"(\/[a-z-]+)":\s*\[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/"([a-z_]+)"/g)].map((r) => r[1])]),
  );
}

function navItems(arrayName) {
  const start = NAV.indexOf(`export const ${arrayName}: NavItem[] = [`);
  const end = NAV.indexOf("\n];", start);
  assert.ok(start >= 0 && end > start, `${arrayName} not found`);
  return [...NAV.slice(start, end).matchAll(/\{\s*href:\s*"([^"]+)"([^}]*)\}/g)].map((match) => ({
    href: match[1],
    roles: /roles:\s*\[/.test(match[2]) ? [...match[2].matchAll(/"([a-z_]+)"/g)].map((r) => r[1]) : null,
  }));
}

test("every sidebar link a role is shown passes the proxy's PROTECTED_ROUTES", () => {
  const routes = protectedRoutes();
  assert.ok(Object.keys(routes).length >= 3, "PROTECTED_ROUTES was not parsed");
  const refused = [];
  for (const [role, array] of Object.entries(ARRAY_FOR_ROLE)) {
    for (const item of navItems(array)) {
      if (item.roles && !item.roles.includes(role)) continue;
      for (const [prefix, allowed] of Object.entries(routes)) {
        if ((item.href === prefix || item.href.startsWith(`${prefix}/`)) && !allowed.includes(role)) {
          refused.push(`${role} is shown ${item.href} but the proxy admits only ${allowed.join(", ")}`);
        }
      }
    }
  }
  assert.deepEqual(refused, []);
});

test("/pipeline admits sales but not finance or designer", () => {
  const roles = protectedRoutes()["/pipeline"];
  assert.deepEqual([...roles].sort(), ["admin", "boss", "operator", "sales"]);
});

test("a salesperson on /pipeline gets the read-only KPI panel, never the board, and the list API stays scoped", () => {
  const page = readFileSync(path.join(ROOT, "src/app/(dashboard)/pipeline/page.tsx"), "utf8");
  const salesBranch = page.indexOf('if (role === "sales")');
  const board = page.indexOf("<KanbanBoard");
  assert.ok(salesBranch > 0 && board > salesBranch, "the sales branch must return before the board is rendered");
  assert.match(page.slice(salesBranch, board), /return <SalesKpiDashboard/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "src/app/(dashboard)/pipeline/_components/SalesKpiDashboard.tsx"), "utf8"), /@\/app\/actions\/pipeline|updateLeadStage|assigned_to/);
  const api = readFileSync(path.join(ROOT, "src/app/api/pipeline/list/route.ts"), "utf8");
  assert.match(api, /if \(isSales\) q = q\.eq\("assigned_to", userId\)/);
  // The server actions the board uses refuse a salesperson on anyone else's lead.
  const actions = readFileSync(path.join(ROOT, "src/app/actions/pipeline.ts"), "utf8");
  assert.match(actions, /lead\.assigned_to !== user\.id\) throw new Error\('Forbidden'\)/);
});
