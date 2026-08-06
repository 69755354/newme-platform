import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SAM-78 permits only exact synthetic audit cleanup after actor deactivation", async () => {
  const [migration, rollback, executor, controller] = await Promise.all([
    read("supabase/migrations/20260806070000_sam78_product_saas_inactive_audit_cleanup_boundary.sql"),
    read("supabase/rollback/20260806070000_sam78_product_saas_inactive_audit_cleanup_boundary_rollback.sql"),
    read("scripts/run-staging-sam78-migrations.mjs"),
    read("scripts/newme-staging-control.sh"),
  ]);
  assert.match(migration, /product_saas_is_synthetic_organization/);
  assert.match(migration, /actor_profile\.email LIKE organization\.slug \|\| '-%@invalid\.test'/);
  assert.match(migration, /organization\.member\.deactivate/);
  assert.doesNotMatch(migration, /actor_profile\.is_active IS TRUE/);
  assert.match(rollback, /actor_profile\.is_active IS TRUE/);
  assert.match(rollback, /requires_staging_or_test/);
  assert.match(executor, /20260806070000/);
  assert.match(controller, /SAM78_MIGRATION_060700/);
  assert.match(controller, /SAM78_ROLLBACK_060700/);
});
