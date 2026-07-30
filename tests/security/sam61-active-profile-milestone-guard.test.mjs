import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) =>
  (await readFile(new URL(`../../${path}`, import.meta.url), "utf8")).replaceAll(
    "\r\n",
    "\n",
  );

function extractFunction(source, name) {
  const pattern = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`,
  );
  const match = source.match(pattern);
  assert.ok(match, `${name} definition missing`);
  return match[0];
}

function expectedForward(source, name) {
  return extractFunction(source, name)
    .replace(
      "SET search_path = public",
      "SET search_path = pg_catalog, public, pg_temp",
    )
    .replace(
      "WHERE id = actor_id;",
      "WHERE id = actor_id\n    AND is_active IS TRUE;",
    );
}

function expectedRollback(source, name) {
  return extractFunction(source, name).replace(
    "SET search_path = public",
    "SET search_path = pg_catalog, public, pg_temp",
  );
}

test("SAM-61 forward migration changes only the two active-profile predicates", async () => {
  const [migration, reopenSource, recompleteSource] = await Promise.all([
    read(
      "supabase/migrations/20260729235704_sam61_require_active_profiles_for_milestone_mutations.sql",
    ),
    read(
      "supabase/migrations/20260719000000_fix_reopen_fact_consistency.sql",
    ),
    read(
      "supabase/migrations/20260718020000_fix_reopen_milestone_keys.sql",
    ),
  ]);

  assert.equal(
    extractFunction(migration, "reopen_lead_milestone"),
    expectedForward(reopenSource, "reopen_lead_milestone"),
  );
  assert.equal(
    extractFunction(migration, "recomplete_lead_milestone"),
    expectedForward(recompleteSource, "recomplete_lead_milestone"),
  );
  assert.equal(
    (migration.match(/CREATE OR REPLACE FUNCTION/g) || []).length,
    2,
  );
  assert.doesNotMatch(
    migration,
    /(?:^|\n)(?:ALTER|DROP|GRANT|REVOKE|COMMENT|NOTIFY)\s/mi,
  );
});

test("SAM-61 rollback exactly restores prior logic while retaining the safe search path", async () => {
  const [rollback, reopenSource, recompleteSource] = await Promise.all([
    read(
      "supabase/rollback/20260729235704_sam61_require_active_profiles_for_milestone_mutations_rollback.sql",
    ),
    read(
      "supabase/migrations/20260719000000_fix_reopen_fact_consistency.sql",
    ),
    read(
      "supabase/migrations/20260718020000_fix_reopen_milestone_keys.sql",
    ),
  ]);

  assert.equal(
    extractFunction(rollback, "reopen_lead_milestone"),
    expectedRollback(reopenSource, "reopen_lead_milestone"),
  );
  assert.equal(
    extractFunction(rollback, "recomplete_lead_milestone"),
    expectedRollback(recompleteSource, "recomplete_lead_milestone"),
  );
  assert.match(
    rollback,
    /sam61_active_profile_rollback_requires_staging_or_test/,
  );
  assert.match(
    rollback,
    /current_setting\('newme\.environment', true\)/,
  );
});

test("SAM-61 disposable database gate is pinned, fail-closed and wired into CI", async () => {
  const [runner, fixture, packageJson, workflow] = await Promise.all([
    read("scripts/run-sam61-active-profile-database-gate.mjs"),
    read("tests/database/sam61-active-profile-milestone-guard.sql"),
    read("package.json"),
    read(".github/workflows/ci.yml"),
  ]);

  assert.match(runner, /postgres:17-alpine@sha256:[a-f0-9]{64}/);
  assert.match(runner, /sam61_rollback_without_environment/);
  assert.match(runner, /finally \{/);
  assert.match(runner, /\["rm", "--force", container\]/);
  assert.match(fixture, /inactive_admin_reopen_side_effect/);
  assert.match(fixture, /inactive_sales_recomplete_side_effect/);
  assert.match(fixture, /anon_reopen_unexpected_success/);
  assert.match(fixture, /anon_recomplete_unexpected_success/);
  assert.match(fixture, /unassigned_sales_reopen_unexpected_success/);

  assert.equal(
    JSON.parse(packageJson).scripts["check:sam61-active-profile-database"],
    "node scripts/run-sam61-active-profile-database-gate.mjs",
  );
  assert.match(
    workflow,
    /npm run check:sam61-active-profile-database/,
  );
});
