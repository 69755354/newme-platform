import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-26 tags only well-formed browser fixture runs", async () => {
  const [proxy, runner] = await Promise.all([
    read("src/proxy.ts"),
    read("scripts/verify-staging-sam26-roles.mjs"),
  ]);

  assert.match(proxy, /SAM26_RUN_ID_PATTERN = \^?\/\^\\d\{13\}-\[0-9a-f\]\{8\}\$\//);
  assert.match(proxy, /request\.headers\.get\("x-newme-sam26-run-id"\)/);
  assert.match(proxy, /fixture_scope: SAM26_FIXTURE_SCOPE/);
  assert.match(proxy, /fixture_run_id: sam26RunId/);
  assert.match(runner, /extraHTTPHeaders: \{ "x-newme-sam26-run-id": runId \}/);
});

test("database exception is DELETE-only, service-role-only, and marker-bound", async () => {
  const migration = await read(
    "supabase/migrations/20260804165734_sam26_synthetic_audit_cleanup_boundary.sql",
  );

  assert.match(migration, /TG_OP = 'DELETE'/);
  assert.match(migration, /TG_TABLE_NAME = 'audit_logs'/);
  assert.match(migration, /current_user = 'service_role'/);
  assert.match(migration, /OLD\.action = 'PAGE_VISIT'/);
  assert.match(migration, /fixture_scope' = 'sam26-staging-uat'/);
  assert.match(migration, /fixture_run_id ~ '\^\\d\{13\}-\[0-9a-f\]\{8\}\$'/);
  assert.match(migration, /organization\.slug = 'sam26-' \|\| fixture_run_id/);
  assert.match(migration, /profile\.email LIKE 'sam26-' \|\| fixture_run_id \|\| '-%@example\.test'/);
  assert.match(migration, /RETURN OLD;/);
  assert.match(migration, /MESSAGE = 'immutable_record'/);
  assert.doesNotMatch(migration, /GRANT EXECUTE/);
});

test("rollback restores strict immutability and is environment-guarded", async () => {
  const rollback = await read(
    "supabase/rollback/20260804165734_sam26_synthetic_audit_cleanup_boundary_rollback.sql",
  );

  assert.match(
    rollback,
    /COALESCE\(current_setting\('newme\.environment', true\), ''\)[\s\S]*NOT IN \('staging', 'test'\)/,
  );
  assert.match(rollback, /MESSAGE = 'immutable_record'/);
  assert.doesNotMatch(rollback, /fixture_scope|RETURN OLD/);
});
