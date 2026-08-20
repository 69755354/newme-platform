/**
 * The contracts read boundary has one declaration, and it matches the database.
 *
 * Round-5-class finding, measured on production 2026-08-20: sales and operator
 * both got `GET /api/contracts -> 200` and were both bounced off /contracts by
 * the page, because the page guard said ["admin", "boss"] while the route said
 * five roles and the detail page said the same five. Three copies of one
 * boundary, and the narrowest copy was the one employees hit.
 *
 * Spelling checks alone would not have caught it -- every copy was spelled
 * correctly -- so this file recomputes the role set from the RLS SELECT policies
 * on public.contracts, which are what actually decide whether a row comes back,
 * and then asserts the four call sites reference the shared constant instead of
 * restating it.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_READ_ALL_ROLES,
  CONTRACT_READ_ROLES,
  canReadContracts,
  contractsScopedToOwner,
} from "../../src/lib/contract-access.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const LIST_PAGE = "src/app/(dashboard)/contracts/page.tsx";
const DETAIL_PAGE = "src/app/(dashboard)/contracts/[id]/page.tsx";
const COLLECTION_ROUTE = "src/app/api/contracts/route.ts";
const LIST_ROUTE = "src/app/api/contracts/list/route.ts";

/**
 * Every role named by a live SELECT policy on public.contracts.
 *
 * Migrations are read in filename order so a later `drop policy` / `create
 * policy` pair wins, which is how the repo actually replaces a policy (see
 * 20260812000000 replacing policy_contracts_update_sales). A policy whose USING
 * clause keys on `sales_id = auth.uid()` names no role literal, and that is the
 * point: sales is admitted by ownership, so it is added separately below.
 */
function selectRolesFromMigrations() {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  const policies = new Map();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(
      /drop\s+policy\s+(?:if\s+exists\s+)?(policy_contracts_select_\w+)/gi,
    )) {
      policies.delete(match[1].toLowerCase());
    }
    for (const match of sql.matchAll(
      /create\s+policy\s+(policy_contracts_select_\w+)\s+on\s+(?:public\.)?contracts\s+for\s+select\b([\s\S]*?);/gi,
    )) {
      policies.set(match[1].toLowerCase(), match[2]);
    }
  }
  assert.ok(policies.size >= 2, `parsed ${policies.size} contracts SELECT policies`);

  const roles = new Set();
  let ownershipPolicies = 0;
  for (const body of policies.values()) {
    const named = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    if (named.length === 0) {
      assert.match(body, /sales_id\s*=\s*auth\.uid\(\)/, "a role-less SELECT policy must key on ownership");
      ownershipPolicies += 1;
      continue;
    }
    for (const role of named) roles.add(role);
  }
  return { allRoles: [...roles].sort(), ownershipPolicies };
}

test("the shared role set is exactly what the RLS SELECT policies admit", () => {
  const { allRoles, ownershipPolicies } = selectRolesFromMigrations();

  // Negative control on the parser: if it silently matched nothing, both sides
  // of the comparison below would be empty and the test would prove nothing.
  assert.ok(allRoles.length >= 3, `parsed only ${allRoles.length} role literals`);
  assert.equal(ownershipPolicies, 1, "expected exactly one ownership-scoped SELECT policy (sales)");

  assert.deepEqual([...CONTRACT_READ_ALL_ROLES].sort(), allRoles);
  assert.deepEqual([...CONTRACT_READ_ROLES].sort(), [...allRoles, "sales"].sort());
});

test("the helpers admit the listed roles and nobody else", () => {
  for (const role of CONTRACT_READ_ROLES) assert.equal(canReadContracts(role), true, role);
  for (const role of ["designer", "", "ADMIN", "admin ", null, undefined, 0, {}]) {
    assert.equal(canReadContracts(role), false, JSON.stringify(role));
  }
  assert.equal(contractsScopedToOwner("sales"), true);
  for (const role of CONTRACT_READ_ALL_ROLES) assert.equal(contractsScopedToOwner(role), false, role);
});

test("both contracts pages guard on the shared constant rather than their own list", () => {
  for (const page of [LIST_PAGE, DETAIL_PAGE]) {
    const source = read(page);
    assert.match(
      source,
      /useRequireRole\(\[\.\.\.CONTRACT_READ_ROLES\]\)/,
      `${page} must guard on the shared constant`,
    );
    assert.match(source, /from "@\/lib\/contract-access\.mjs"/, `${page} must import it`);
    // The literal the constant replaced, in either page's spelling.
    assert.doesNotMatch(
      source,
      /useRequireRole\(\[\s*"/,
      `${page} still restates a role list inline`,
    );
  }
});

test("both contracts read routes gate and scope through the shared helpers", () => {
  for (const route of [COLLECTION_ROUTE, LIST_ROUTE]) {
    const source = read(route);
    assert.match(source, /canReadContracts\(/, `${route} must refuse unlisted roles`);
    assert.match(source, /status: 403/, `${route} must answer 403 when it refuses`);
    assert.doesNotMatch(
      source,
      /\[\s*"admin",\s*"boss",\s*"sales"/,
      `${route} still restates the read role list inline`,
    );
  }
  // Sales narrowing is a row filter, not a role check, and must not be spelled
  // twice either: an unscoped sales list is a cross-salesperson data leak.
  for (const route of [COLLECTION_ROUTE, LIST_ROUTE]) {
    const source = read(route);
    assert.match(source, /contractsScopedToOwner\(/, `${route} must scope sales through the helper`);
    assert.match(source, /eq\("sales_id"/, `${route} must apply the owner filter`);
  }
});
