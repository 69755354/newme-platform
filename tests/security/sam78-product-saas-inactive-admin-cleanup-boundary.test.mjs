import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SAM-78 keeps Product/SaaS cleanup marker-bound after the synthetic admin is inactive", async () => {
  const [migration, rollback, executor, controller] = await Promise.all([
    read("supabase/migrations/20260806080000_sam78_product_saas_inactive_admin_cleanup_boundary.sql"),
    read("supabase/rollback/20260806080000_sam78_product_saas_inactive_admin_cleanup_boundary_rollback.sql"),
    read("scripts/run-staging-sam78-migrations.mjs"),
    read("scripts/newme-staging-control.sh"),
  ]);
  assert.match(migration, /profile\.email = organization\.slug \|\| '-admin@invalid\.test'/);
  assert.match(migration, /organization\.billable_seat_limit = 10/);
  assert.doesNotMatch(migration, /profile\.is_active IS TRUE/);
  assert.match(rollback, /profile\.is_active IS TRUE/);
  assert.match(rollback, /requires_staging_or_test/);
  assert.match(executor, /20260806080000/);
  assert.match(controller, /SAM78_MIGRATION_060800/);
  assert.match(controller, /SAM78_ROLLBACK_060800/);
});
