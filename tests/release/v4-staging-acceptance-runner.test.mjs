import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEnvironment, STAGING_REF, CONFIRMATION, FIXED_MANIFEST } from "../../scripts/uat/v4-staging-acceptance.mjs";

const read = (path) => readFile(path, "utf8");
const SHA = "a".repeat(40);
const environment = () => ({
  V4_UAT_CONFIRM: CONFIRMATION,
  V4_UAT_RELEASE_SHA: SHA,
  V4_UAT_RELEASE_MANIFEST: FIXED_MANIFEST,
  NEWME_STAGING_PROJECT_REF: STAGING_REF,
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
  NEWME_READINESS_TOKEN: "test-readiness-token",
  V4_UAT_BASE_URL: "http://127.0.0.1:3101",
});

test("V4 acceptance environment is exact staging-only and fail closed", () => {
  assert.equal(validateEnvironment(environment()).releaseSha, SHA);
  for (const [key, value] of [
    ["V4_UAT_CONFIRM", "wrong"], ["V4_UAT_BASE_URL", "https://staging.newme.ae"],
    ["NEWME_STAGING_PROJECT_REF", "vfopmpxlhwzpxqegayew"], ["SUPABASE_SERVICE_ROLE_KEY", "anon-test-key"],
  ]) {
    const env = environment(); env[key] = value;
    assert.throws(() => validateEnvironment(env), /V4_STAGING_UAT_FAIL_CLOSED/);
  }
});

test("one SHA-bound action integrates four V4 scenarios and strict cleanup", async () => {
  const [runner, controller, dockerfile, shell, readme] = await Promise.all([
    read("scripts/uat/v4-staging-acceptance.mjs"), read("scripts/newme-staging-control.sh"),
    read("infra/staging/uat-runner/Dockerfile"), read("infra/staging/uat-runner/run.sh"), read("infra/staging/uat-runner/README.md"),
  ]);
  for (const scenario of ["SAM-81", "SAM-83", "SAM-84", "SAM-86"]) assert.match(runner, new RegExp(`"${scenario}"`));
  for (const marker of ["V4_STAGING_ACCEPTANCE_ONLY", "V4_UAT_BASE_URL", "marker_only", "cleanup", "agent_gateway_adapter_registry", "receipt_idempotency", "fulfillment", "finance", "release_sha"]) assert.match(runner, new RegExp(marker));
  assert.match(runner, /plan_key: "growth", billable_seat_limit: 20/);
  assert.doesNotMatch(runner, /plan_key: "growth", billable_seat_limit: 5/);
  assert.match(runner, /normalized_email: `\$\{state\.marker\}@invalid\.test`\.toLowerCase\(\)/);
  assert.match(runner, /source: "other", stage: "won", quality: "good"/);
  assert.doesNotMatch(runner, /source: "other", stage: "won", quality: "high"/);
  assert.match(runner, /quotation_type: "standard", status: "accepted"/);
  assert.doesNotMatch(runner, /quotation_type: "retail"/);
  assert.match(runner, /createRetailCodActor\(state, "collector"\)/);
  assert.match(runner, /createRetailCodActor\(state, "handover"\)/);
  assert.match(runner, /createRetailCodActor\(state, "finance"\)/);
  assert.match(runner, /\["cash_collected", collectorId\], \["cash_handover", handoverId\], \["finance_confirmed", financeId\]/);
  assert.match(runner, /organization_id: state\.organizations\.real_estate, membership_id: membership\.id, role_id: role\.id/);
  assert.match(runner, /production_reference_detected/);
  assert.doesNotMatch(runner, /console\.log\(.*(?:SERVICE_ROLE|ANON_KEY|Bearer)/);
  for (const pattern of [
    /V4_ACCEPTANCE_RUNNER="scripts\/uat\/v4-staging-acceptance\.mjs"/,
    /V4_ACCEPTANCE_EVIDENCE="\$STATE_DIR\/last-uat-v4-acceptance\.json"/,
    /uat-v4\) run_uat_v4/,
    /SAM_UAT_SUITE=v4-acceptance/,
    /V4_UAT_RELEASE_SHA=\$SHA/,
    /V4_UAT_BASE_URL=http:\/\/127\.0\.0\.1:3101/,
    /body\.cleanup\?\.status !== "verified"/,
    /body\.scenarios\?\.\["SAM-84"\]\?\.adapters !== "disabled"/,
    /install -m 0600 -o root -g root "\$output" "\$evidence_tmp"/,
  ]) assert.match(controller, pattern);
  assert.match(dockerfile, /COPY v4-staging-acceptance\.mjs \/runner\/v4-staging-acceptance\.mjs/);
  assert.match(shell, /v4-acceptance\)/);
  assert.match(shell, /exec node \/runner\/v4-staging-acceptance\.mjs/);
  assert.match(readme, /uat-v4 <SHA>/);
});

test("V4 acceptance cleanup removes generated tenant defaults before fixture parents", async () => {
  const runner = await read("scripts/uat/v4-staging-acceptance.mjs");
  const cleanup = runner.slice(runner.indexOf("async function cleanup"));
  for (const table of [
    "user_session_daily", "commercial_seat_events", "paid_seat_allocations",
    "commercial_entitlements", "organization_subscriptions", "retail_inventory_movements",
    "retail_price_book_items", "shared_outbox",
  ]) assert.match(cleanup, new RegExp(`\\["${table}"`));
  assert.match(cleanup, /removeByOrganizations\(a, table, i\.organizations, label\)/);
  assert.match(cleanup, /removeByActors\(a, "agent_gateway_events", i\.auth, "agent_gateway_events"\)/);
  assert.match(cleanup, /removeByActors\(a, "agent_gateway_commands", i\.auth, "agent_gateway_commands"\)/);
  assert.match(cleanup, /removeByProfileColumn\(a, "shared_timeline_events", "actor_user_id", i\.auth, "shared_timeline_events"\)/);
  assert.match(cleanup, /removeByProfileColumn\(a, "shared_approval_requests", "requested_by", i\.auth, "shared_approval_requests"\)/);
  assert.match(runner, /cleanup_profile_relation_not_allowlisted/);
  assert.match(cleanup, /await remove\(a, "profiles", i\.auth, "profiles"\);/);
  assert.ok(cleanup.indexOf('"commercial_seat_events"') < cleanup.indexOf('"paid_seat_allocations"'));
  assert.ok(cleanup.indexOf('"paid_seat_allocations"') < cleanup.indexOf('"memberships"'));
  assert.ok(cleanup.indexOf('"shared_outbox"') < cleanup.lastIndexOf('"organizations"'));
  assert.ok(cleanup.indexOf('"retail_inventory_movements"') < cleanup.indexOf('"retail_skus"'));
  assert.ok(cleanup.indexOf('"retail_price_book_items"') < cleanup.indexOf('"retail_skus"'));
  assert.ok(cleanup.indexOf('"agent_gateway_events"') < cleanup.indexOf('"agent_gateway_commands"'));
  assert.ok(cleanup.indexOf('"agent_gateway_commands"') < cleanup.indexOf('"profiles"'));
  assert.ok(cleanup.indexOf('"shared_timeline_events"') < cleanup.indexOf('"profiles"'));
  assert.ok(cleanup.indexOf('"shared_approval_requests"') < cleanup.indexOf('"profiles"'));
  assert.ok(cleanup.indexOf('"profiles"') < cleanup.lastIndexOf('"organizations"'));
});

test("SAM-82, SAM-83, and SAM-84 keep append-only facts except for marker-scoped staging cleanup", async () => {
  const [migration, caseFixMigration, rollback, caseFixRollback, gatewayMigration, gatewayRollback, inventoryMigration, inventoryRollback, executor, controller, history] = await Promise.all([
    read("supabase/migrations/20260806020000_sam83_v4_synthetic_cleanup_boundary.sql"),
    read("supabase/migrations/20260806030000_sam83_v4_synthetic_cleanup_marker_case.sql"),
    read("supabase/rollback/20260806020000_sam83_v4_synthetic_cleanup_boundary_rollback.sql"),
    read("supabase/rollback/20260806030000_sam83_v4_synthetic_cleanup_marker_case_rollback.sql"),
    read("supabase/migrations/20260806040000_sam84_v4_synthetic_gateway_cleanup_boundary.sql"),
    read("supabase/rollback/20260806040000_sam84_v4_synthetic_gateway_cleanup_boundary_rollback.sql"),
    read("supabase/migrations/20260806050000_sam82_v4_synthetic_inventory_cleanup_boundary.sql"),
    read("supabase/rollback/20260806050000_sam82_v4_synthetic_inventory_cleanup_boundary_rollback.sql"),
    read("scripts/run-staging-sam78-migrations.mjs"),
    read("scripts/newme-staging-control.sh"),
    read("scripts/uat/sam78-canonical-migration-history.txt"),
  ]);
  assert.match(migration, /TG_OP = 'DELETE'/);
  assert.match(migration, /current_user = 'service_role'/);
  assert.doesNotMatch(migration, /organization\.slug ~\*/);
  assert.match(caseFixMigration, /organization\.slug ~\*/);
  assert.match(migration, /\^v4-uat-\[0-9a-f\]\{12\}-\[0-9a-f\]\{8\}-\(real_estate\|retail\)\$/);
  assert.match(migration, /retail_sam83_fact_is_append_only/);
  assert.match(rollback, /sam83_v4_synthetic_cleanup_rollback_requires_staging_or_test/);
  assert.match(caseFixRollback, /sam83_v4_synthetic_cleanup_marker_case_rollback_requires_staging_or_test/);
  assert.match(gatewayMigration, /TG_TABLE_NAME IN \('agent_gateway_commands', 'agent_gateway_events'\)/);
  assert.match(gatewayMigration, /current_user = 'service_role'/);
  assert.match(gatewayMigration, /organization\.slug ~\* '\^v4-uat-/);
  assert.match(gatewayMigration, /agent_gateway_record_immutable/);
  assert.match(gatewayRollback, /sam84_v4_synthetic_gateway_cleanup_boundary_rollback_requires_staging_or_test/);
  assert.match(inventoryMigration, /TG_TABLE_NAME = 'retail_inventory_movements'/);
  assert.match(inventoryMigration, /current_user = 'service_role'/);
  assert.match(inventoryMigration, /organization\.slug ~\* '\^v4-uat-/);
  assert.match(inventoryMigration, /retail_inventory_movement_is_append_only/);
  assert.match(inventoryMigration, /GRANT SELECT \(id, slug, name\) ON TABLE public\.organizations TO service_role/);
  assert.match(inventoryRollback, /sam82_v4_synthetic_inventory_cleanup_boundary_rollback_requires_staging_or_test/);
  assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]*authenticated/);
  for (const marker of [
    'version: "20260806020000"', 'version: "20260806030000"', 'version: "20260806040000"', 'version: "20260806050000"',
    "SAM83_MIGRATION_060200_PATH", "SAM83_MIGRATION_060300_PATH", "SAM84_MIGRATION_060400_PATH", "SAM82_MIGRATION_060500_PATH",
    "SAM83_ROLLBACK_060200_PATH", "SAM83_ROLLBACK_060300_PATH", "SAM84_ROLLBACK_060400_PATH", "SAM82_ROLLBACK_060500_PATH",
    "20260806020000\tsam83_v4_synthetic_cleanup_boundary",
    "20260806030000\tsam83_v4_synthetic_cleanup_marker_case",
    "20260806040000\tsam84_v4_synthetic_gateway_cleanup_boundary",
    "20260806050000\tsam82_v4_synthetic_inventory_cleanup_boundary",
  ]) assert.ok(`${executor}\n${controller}\n${history}`.includes(marker), `missing controlled migration marker ${marker}`);
});
