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
    "commercial_entitlements", "organization_subscriptions",
  ]) assert.match(cleanup, new RegExp(`\\["${table}"`));
  assert.match(cleanup, /removeByOrganizations\(a, table, i\.organizations, label\)/);
  assert.match(cleanup, /await remove\(a, "profiles", i\.auth, "profiles"\);/);
  assert.ok(cleanup.indexOf('"commercial_seat_events"') < cleanup.indexOf('"paid_seat_allocations"'));
  assert.ok(cleanup.indexOf('"paid_seat_allocations"') < cleanup.indexOf('"memberships"'));
  assert.ok(cleanup.indexOf('"profiles"') < cleanup.lastIndexOf('"organizations"'));
});
