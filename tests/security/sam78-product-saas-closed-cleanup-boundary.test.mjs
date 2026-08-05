import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("SAM-78 permits immutable audit cleanup only for exact closed Product/SaaS fixtures", async () => {
  const [migration, rollback, executor, controller, databaseGate] = await Promise.all([
    read("supabase/migrations/20260806060000_sam78_product_saas_closed_cleanup_boundary.sql"),
    read("supabase/rollback/20260806060000_sam78_product_saas_closed_cleanup_boundary_rollback.sql"),
    read("scripts/run-staging-sam78-migrations.mjs"),
    read("scripts/newme-staging-control.sh"),
    read("scripts/run-sam23-database-gate.mjs"),
  ]);

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.product_saas_is_synthetic_organization/);
  assert.match(migration, /organization\.status IN \('active', 'read_only', 'closed'\)/);
  assert.doesNotMatch(migration, /'suspended'|'export_only'/);
  for (const predicate of [
    "^product-saas-",
    "[PRODUCT-UAT ",
    "organization.industry_key = 'real_estate'",
    "organization.plan_key = 'growth'",
    "organization.billable_seat_limit = 10",
    "-admin@invalid.test",
    "profile.role = 'admin'",
    "profile.is_active IS TRUE",
  ]) assert.ok(migration.includes(predicate), `missing exact predicate: ${predicate}`);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.product_saas_is_synthetic_organization[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.product_saas_is_synthetic_organization[\s\S]*TO service_role/);

  assert.match(rollback, /sam78_product_saas_closed_cleanup_rollback_requires_staging_or_test/);
  assert.match(rollback, /organization\.status = 'active'/);
  assert.doesNotMatch(rollback, /'read_only'|'closed'/);
  assert.match(executor, /20260806060000/);
  assert.match(controller, /SAM78_MIGRATION_060600/);
  assert.match(controller, /SAM78_ROLLBACK_060600/);
  assert.match(databaseGate, /sam78_product_saas_closed_cleanup_boundary_apply/);
  assert.match(databaseGate, /sam78_product_saas_closed_cleanup_boundary_fixture/);
});
