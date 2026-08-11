/**
 * F-09 · the money-grant / call-site coupling.
 *
 * The revision of 20260811100400_f09_money_authorization_phase1.sql that went to
 * review revoked INSERT/UPDATE/DELETE on contracts, payments, installment_plans,
 * contract_approvals and quotations from `authenticated`, on the belief that all
 * money writes go through service_role. They do not: many call sites write those
 * tables with the CALLER'S client (createServerSupabase → Postgres role
 * `authenticated`), and server components read them the same way. Shipping that
 * revoke would have taken every contract, payment and quote-conversion write
 * offline — a full money-path outage caused by a security fix.
 *
 * The executable proof lives in supabase/replay/10_assert_release_contracts.sql
 * and runs in the migration-replay CI job, which actually queries
 * has_table_privilege() against a replayed schema. This file guards the coupling
 * that a database cannot see: what the source code does, and whether the
 * migration and the assertions still agree with it.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const MONEY_TABLES = [
  "contracts",
  "payments",
  "installment_plans",
  "contract_approvals",
  "quotations",
];

const WRITE_OPS = ["insert", "update", "upsert", "delete"];

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(rel)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Writes to `table` that are NOT made with the service-role client.
 *
 * The supabase-js builder puts the client, the table and the operation in one
 * expression, so the statement is reconstructed by joining the `from("table")`
 * line with the two lines on either side and asking whether `supabaseAdmin` (or a
 * locally built service-role client) appears in it. Deliberately conservative:
 * anything it cannot attribute to service_role counts as caller-scoped, because
 * for this invariant a false positive is harmless and a false negative is an
 * outage.
 */
function callerScopedWrites(source, table) {
  const lines = source.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    if (!line.includes(`from("${table}")`)) return;
    const statement = lines.slice(Math.max(0, index - 2), index + 3).join(" ");
    if (!WRITE_OPS.some((op) => statement.includes(`.${op}(`))) return;
    if (/supabaseAdmin|serviceRole|SERVICE_ROLE|getSupabaseAdmin|\badmin\./.test(statement)) return;
    hits.push(index + 1);
  });
  return hits;
}

test("the F-09 migration changes function privileges only, never table privileges", async () => {
  const migration = await readFile(
    new URL("supabase/migrations/20260811100400_f09_money_authorization_phase1.sql", `file://${ROOT}/`),
    "utf8",
  );

  // Comments are stripped first. This migration's header quotes the removed
  // leg-2 statements verbatim as the record of why they were removed, so a check
  // that reads the whole file would match its own documentation.
  const sql = migration.replace(/--[^\n]*/g, " ").toLowerCase();

  // Every REVOKE and GRANT in this migration must name a FUNCTION. A statement
  // that revokes a table privilege is the outage.
  const statements = sql
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /^(revoke|grant)\b/.test(s));

  assert.ok(statements.length > 0, "the migration must contain privilege statements");
  for (const statement of statements) {
    assert.match(
      statement,
      /\bon function\b/,
      `F-09 must not touch table privileges, found: ${statement}`,
    );
  }

  for (const table of MONEY_TABLES) {
    assert.doesNotMatch(
      sql,
      new RegExp(`revoke[^;]*\\bon\\s+(table\\s+)?(public\\.)?${table}\\b`),
      `F-09 must not revoke table privileges on ${table}`,
    );
  }
});

test("every money table with a caller-scoped write has a replay assertion keeping its grant", async () => {
  const assertions = await readFile(
    new URL("supabase/replay/10_assert_release_contracts.sql", `file://${ROOT}/`),
    "utf8",
  );

  const files = [...(await sourceFiles("src/app")), ...(await sourceFiles("src/lib"))];
  const withCallerScopedWrites = new Set();
  const evidence = [];

  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    for (const table of MONEY_TABLES) {
      for (const line of callerScopedWrites(source, table)) {
        withCallerScopedWrites.add(table);
        evidence.push(`${file}:${line} (${table})`);
      }
    }
  }

  // A tripwire, not an accident. If this ever becomes empty, every money write
  // has moved to service_role and the grants CAN be tightened — but that is a
  // deliberate change that must move this test and the replay's
  // f09-authenticated-retains-* assertions in the same commit.
  assert.ok(
    withCallerScopedWrites.size > 0,
    "no caller-scoped money writes found; if that is intentional, tighten the grants and update this test together with the replay assertions",
  );

  for (const table of withCallerScopedWrites) {
    assert.match(
      assertions,
      new RegExp(`f09-authenticated-retains-${table.replace(/_/g, "-")}-`),
      `${table} is written with the caller's client, so the replay must assert authenticated keeps its grant. Sites: ${evidence.filter((e) => e.endsWith(`(${table})`)).join(", ")}`,
    );
  }
});

/**
 * The role list each money routine is actually installed with.
 *
 * Migrations are read in filename order and the LAST definition of the routine
 * wins, because that is what applying them in order leaves in the database — the
 * round-3 migration replaces bodies the round-2 migration created, and reading the
 * first match would assert against a function no longer installed.
 */
async function installedRoleLists(routine) {
  const dir = path.join(ROOT, "supabase/migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let roles = null;
  let source = null;
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    const definition = new RegExp(
      `create or replace function public\\.${routine}\\s*\\(([\\s\\S]*?)\\n\\$\\$;`,
      "g",
    );
    for (const match of sql.matchAll(definition)) {
      const actor = /money_actor\(\s*[^,]+,\s*array\[([^\]]*)\]/.exec(match[1]);
      if (!actor) continue;
      roles = actor[1]
        .split(",")
        .map((r) => r.trim().replace(/^'|'$/g, ""))
        .filter(Boolean);
      source = `${file}`;
    }
  }
  return { roles, source };
}

/**
 * P1-9. The settlement rule was written down in four places that disagreed: the
 * route handlers and the RBAC header said admin/boss/finance, this page offered the
 * Confirm and Allocate buttons to `operator` as well, and confirm_payment() and
 * allocate_payment() accepted 'operator' — so an operator who was shown a button
 * that "did nothing" could still settle money by calling the RPC directly.
 *
 * The database is now the authority and this test is the coupling: the page's
 * constant has to equal the routines' own lists, so narrowing one without the other
 * is a red test rather than a silent re-divergence. What the database refuses is
 * proved in supabase/replay/10_assert_release_contracts.sql (the
 * money-operator-refused-by-* assertions); what a JS file cannot check there is
 * whether the UI still agrees.
 */
test("the settlement roles in the payments UI equal the roles the settlement routines accept", async () => {
  const page = await readFile(path.join(ROOT, "src/app/(dashboard)/payments/page.tsx"), "utf8");

  const declared = /const SETTLEMENT_ROLES = \[([^\]]*)\]/.exec(page);
  assert.ok(declared, "src/app/(dashboard)/payments/page.tsx must declare SETTLEMENT_ROLES");
  const uiRoles = declared[1]
    .split(",")
    .map((r) => r.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  assert.ok(!uiRoles.includes("operator"), "the settlement surface is not an operator surface");

  for (const routine of ["confirm_payment", "allocate_payment", "void_payment"]) {
    const { roles, source } = await installedRoleLists(routine);
    assert.ok(roles, `no installed definition of ${routine} passes a role list to money_actor()`);
    assert.deepEqual(
      [...roles].sort(),
      [...uiRoles].sort(),
      `${routine} (last defined in ${source}) accepts ${roles.join("/")} but the payments page offers the buttons to ${uiRoles.join("/")}`,
    );
  }

  // The constant proves nothing if the buttons are still gated on the recording
  // rule. `isPrivileged` stays — it is the correct rule for recording a payment and
  // for seeing every payment — so the check is that the two settlement actions moved
  // off it, not that it is gone. Each action is found by its handler and the guard is
  // read from the JSX conditional immediately above it.
  const lines = page.split(/\r?\n/);
  for (const handler of ["handleConfirm(payment.id)", "openAllocateDialog(payment)"]) {
    const at = lines.findIndex((line) => line.includes(handler));
    assert.ok(at !== -1, `the payments page no longer calls ${handler}`);
    const guard = lines.slice(Math.max(0, at - 6), at).join(" ");
    assert.match(guard, /canSettle/, `${handler} is not gated on canSettle: ${guard.trim()}`);
    assert.doesNotMatch(
      guard,
      /isPrivileged/,
      `${handler} is still gated on the recording rule: ${guard.trim()}`,
    );
  }
});

test("the replay asserts anon cannot execute the money routines", async () => {
  const assertions = await readFile(
    new URL("supabase/replay/10_assert_release_contracts.sql", `file://${ROOT}/`),
    "utf8",
  );
  // The actual F-09 defect: EXECUTE was held via PUBLIC, so anon — an unauthenticated
  // request carrying only the publishable key — could call SECURITY DEFINER routines
  // that approve contracts and confirm payments.
  for (const routine of ["confirm-payment", "approve-contract", "allocate-payment"]) {
    assert.match(assertions, new RegExp(`f09-anon-cannot-execute-${routine}`));
    assert.match(assertions, new RegExp(`f09-authenticated-can-execute-${routine}`));
  }
});
