import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("SAM-78 Product/SaaS cleanup remains exact, service-only, and reversible", async () => {
  const [migration, rollback, inactiveCleanupMigration, inactiveCleanupRollback, runner, controller, databaseGate] = await Promise.all([
    read("supabase/migrations/20260805000000_sam78_product_saas_synthetic_cleanup_boundary.sql"),
    read("supabase/rollback/20260805000000_sam78_product_saas_synthetic_cleanup_boundary_rollback.sql"),
    read("supabase/migrations/20260806100000_sam78_product_saas_inactive_exit_approval_cleanup_boundary.sql"),
    read("supabase/rollback/20260806100000_sam78_product_saas_inactive_exit_approval_cleanup_boundary_rollback.sql"),
    read("scripts/uat/product-saas-final.mjs"),
    read("scripts/newme-staging-control.sh"),
    read("scripts/run-sam23-database-gate.mjs"),
  ]);

  for (const helper of [
    "product_saas_is_synthetic_organization",
    "product_saas_is_synthetic_exit_approval",
    "product_saas_is_synthetic_audit_log",
    "product_saas_is_synthetic_audit_event",
  ]) {
    assert.match(migration, new RegExp("CREATE OR REPLACE FUNCTION public\\." + helper));
    assert.match(migration, new RegExp(
      "REVOKE ALL ON FUNCTION public\\." + helper
        + "[\\s\\S]*FROM PUBLIC, anon, authenticated",
    ));
    assert.match(migration, new RegExp(
      "GRANT EXECUTE ON FUNCTION public\\." + helper + "[\\s\\S]*TO service_role",
    ));
    assert.match(rollback, new RegExp("DROP FUNCTION public\\." + helper));
  }

  for (const exactMarker of [
    "^product-saas-",
    "[PRODUCT-UAT ",
    "organization.plan_key = 'growth'",
    "organization.billable_seat_limit = 10",
    "-admin@invalid.test",
    "-boss@invalid.test",
    "Synthetic customer-approved staging exit verification",
    "synthetic-staging-seven-year-contractual-retention",
    "organization.exit.prepare",
    "organization.exit.complete",
    "organization.customer_export.v4",
    "organization.exit_prepared",
    "organization.exit_completed",
    "organization.member.deactivate",
    "organization_membership_role_created",
    "lead.import",
  ]) {
    assert.ok(migration.includes(exactMarker), "migration omitted exact marker: " + exactMarker);
  }
  assert.match(migration, /current_user = 'service_role'/);
  assert.match(migration, /approval\.status IN \('pending', 'approved', 'consumed'\)/);
  assert.match(migration, /approval\.status = 'pending'[\s\S]*approved_by_platform_staff_id IS NULL/);
  assert.match(migration, /approval\.status = 'approved'[\s\S]*execution_result IS NULL/);
  assert.match(migration, /approval\.status = 'consumed'[\s\S]*execution_result ->> 'organization_id'/);
  assert.match(migration, /product_saas_is_synthetic_audit_log\(OLD\.id\)/);
  assert.match(migration, /sam20_is_synthetic_support_approval/);
  assert.match(migration, /sam26-staging-uat/);
  assert.doesNotMatch(migration, /current_user = 'service_role'\s+THEN RETURN OLD/);

  assert.match(rollback, /sam78_product_saas_cleanup_rollback_requires_staging_or_test/);
  assert.match(rollback, /sam20_is_synthetic_support_approval/);
  assert.match(rollback, /sam26-staging-uat/);
  assert.doesNotMatch(rollback, /product_saas_is_synthetic_[a-z_]+\(OLD/);

  for (const helper of [
    "product_saas_is_synthetic_exit_approval",
    "product_saas_is_synthetic_audit_log",
  ]) {
    assert.match(inactiveCleanupMigration, new RegExp("CREATE OR REPLACE FUNCTION public\\." + helper));
    assert.match(inactiveCleanupMigration, new RegExp("GRANT EXECUTE ON FUNCTION public\\." + helper + "[\\s\\S]*TO service_role"));
    assert.match(inactiveCleanupRollback, new RegExp("CREATE OR REPLACE FUNCTION public\\." + helper));
  }
  assert.doesNotMatch(inactiveCleanupMigration, /requester_profile\.is_active IS TRUE/);
  assert.doesNotMatch(inactiveCleanupMigration, /approver_profile\.is_active IS TRUE/);
  assert.doesNotMatch(inactiveCleanupMigration, /actor_profile\.is_active IS TRUE/);
  assert.match(inactiveCleanupRollback, /requester_profile\.is_active IS TRUE/);
  assert.match(inactiveCleanupRollback, /approver_profile\.is_active IS TRUE/);
  assert.match(inactiveCleanupRollback, /actor_profile\.is_active IS TRUE/);

  assert.ok(
    runner.indexOf('await capture("platform approval events"') <
      runner.indexOf('await capture("platform approvals"'),
    "approval events must be removed before approvals",
  );
  assert.ok(
    runner.indexOf('await capture("platform approvals"') <
      runner.indexOf('await capture("platform staff"'),
    "approvals must be removed before their staff identities",
  );
  for (const residue of [
    "platform_action_approvals",
    "platform_action_approval_events",
  ]) {
    assert.ok(runner.includes(residue + ": await exactCount("));
    assert.ok(controller.includes('"' + residue + '"'));
  }
  for (const marker of [
    "sam78_product_saas_synthetic_cleanup_boundary_apply",
    "sam78_product_saas_synthetic_cleanup_boundary_fixture",
    "sam78_product_saas_cleanup_rollback_not_fail_closed",
    "sam78_product_saas_synthetic_cleanup_boundary_rollback_verify",
  ]) {
    assert.ok(databaseGate.includes(marker), "database gate omitted " + marker);
  }
});
