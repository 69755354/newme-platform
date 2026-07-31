import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONFIRMATION,
  FIXED_MANIFEST_PATH,
  LINEAR_IDS,
  NON_MANAGEMENT_ROLES,
  PRODUCTION_PROJECT_REF,
  SAM13_CONTRACT_VERSION,
  SAM13_DANGEROUS_PATHS,
  STAGING_PROJECT_REF,
  validateEnvironment,
  verifyReleaseBoundary,
} from "../../scripts/uat/product-saas-final.mjs";

const SHA = "c3087f4553cc971a3488a761eacd9dd16d6df9fe";
const baseEnv = () => ({
  PRODUCT_UAT_CONFIRM: CONFIRMATION,
  NEWME_STAGING_PROJECT_REF: STAGING_PROJECT_REF,
  PRODUCT_UAT_BASE_URL: "https://staging.newme.ae",
  PRODUCT_UAT_RELEASE_SHA: SHA,
  PRODUCT_UAT_RELEASE_MANIFEST: FIXED_MANIFEST_PATH,
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-value",
});

test("validates the exact staging-only environment", () => {
  const config = validateEnvironment(baseEnv());
  assert.equal(config.releaseSha, SHA);
  assert.equal(config.manifestPath, FIXED_MANIFEST_PATH);
  assert.equal(config.baseUrl, "https://staging.newme.ae");
});

test("fails closed when confirmation, project, SHA, manifest, or URL drifts", () => {
  for (const patch of [
    { PRODUCT_UAT_CONFIRM: "yes" },
    { NEWME_STAGING_PROJECT_REF: "another-project" },
    { PRODUCT_UAT_RELEASE_SHA: "c3087f4" },
    { PRODUCT_UAT_RELEASE_MANIFEST: "/tmp/manifest.json" },
    { PRODUCT_UAT_BASE_URL: "https://app.newme.ae" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" },
  ]) {
    assert.throws(
      () => validateEnvironment({ ...baseEnv(), ...patch }),
      /PRODUCT_SAAS_UAT_FAIL_CLOSED/,
    );
  }
});

test("rejects the production project reference in every supplied value", () => {
  assert.throws(
    () => validateEnvironment({
      ...baseEnv(),
      UNRELATED_RUNTIME_VALUE: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
    }),
    /production project reference/,
  );
});

test("verifies local manifest git_sha and manual health before writes", async () => {
  const config = validateEnvironment(baseEnv());
  const calls = [];
  const release = await verifyReleaseBoundary(config, {
    readManifest: async (path, encoding) => {
      assert.equal(path, FIXED_MANIFEST_PATH);
      assert.equal(encoding, "utf8");
      return JSON.stringify({ git_sha: SHA });
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(release, {
    project: STAGING_PROJECT_REF,
    release_sha: SHA,
    health: 200,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://staging.newme.ae/api/health");
  assert.equal(calls[0].options.redirect, "manual");
});

test("health redirect, unhealthy body, and manifest SHA mismatch all stop the run", async () => {
  const config = validateEnvironment(baseEnv());
  await assert.rejects(
    verifyReleaseBoundary(config, {
      readManifest: async () => JSON.stringify({ git_sha: "0".repeat(40) }),
      fetch: async () => {
        throw new Error("must not reach health after manifest mismatch");
      },
    }),
    /manifest git_sha/,
  );
  await assert.rejects(
    verifyReleaseBoundary(config, {
      readManifest: async () => JSON.stringify({ git_sha: SHA }),
      fetch: async () => new Response("", { status: 302 }),
    }),
    /HTTP 302/,
  );
  await assert.rejects(
    verifyReleaseBoundary(config, {
      readManifest: async () => JSON.stringify({ git_sha: SHA }),
      fetch: async () => new Response(JSON.stringify({ status: "degraded" }), { status: 200 }),
    }),
    /status is not ok/,
  );
});

test("runner source pins required issue paths, markers, guards, and cleanup evidence", async () => {
  const source = await readFile(
    new URL("../../scripts/uat/product-saas-final.mjs", import.meta.url),
    "utf8",
  );
  for (const linearId of LINEAR_IDS) assert.match(source, new RegExp(`"${linearId}"`));
  for (const contract of [
    "/api/leads/import/preview",
    "/api/leads/import/confirm",
    "/api/leads/archive",
    "/api/dashboard/summary?month=",
    "/contacts",
    "/quality",
    "/milestone",
    "/timeline?limit=100",
    "/api/hermes/generate-quote",
    "/api/quotations/${generated.payload.quote_id}/convert",
    "/api/payments/${payment.payload.id}/confirm",
    "/api/payments/${payment.payload.id}/allocate",
    "Unknown device_ids",
    "Quotation total must be greater than zero",
    "devices_json: { product_saas_unknown_device: 1 }",
    "devices_json: { knx_ip_router: 0 }",
    "next_quote_no",
    "audit_logs",
    "activity_logs",
    "activities by user",
    "payment_allocations",
    "contract_approvals",
    "pipeline_notifications",
    "user_session_daily",
    "x-newme-organization-id",
    "tenant_id: state.organizationId",
    'const sessionDate = "2099-12-31"',
    "new URL(inactiveTeam.location, state.config.baseUrl)",
    "@invalid.test",
    'report.cleanup = "verified"',
  ]) {
    assert.ok(source.includes(contract), `runner is missing contract marker: ${contract}`);
  }
  assert.ok(source.includes('app_metadata: {'), "fixture ownership must use app_metadata");
  assert.ok(source.includes("run_id: state.runId"), "fixture app_metadata must include run_id");
  assert.ok(source.includes("redirect: \"manual\""), "release checks must not follow redirects");
  assert.ok(!source.includes("console.log("), "runner must not log credential-bearing state");
  assert.match(
    source,
    /directlyDeletedLeadTables = leadTables\.filter\([\s\S]*table !== "lead_milestones"/,
  );
  assert.match(source, /from\("activity_logs"\)\.delete\(\)\.eq\("user_id", id\)/);
  assert.match(source, /from\("activities"\)\.delete\(\)\.eq\("user_id", id\)/);
});

test("SAM-13 staging contract dynamically covers A-D without a new controller action", async () => {
  assert.equal(SAM13_CONTRACT_VERSION, 1);
  assert.deepEqual(NON_MANAGEMENT_ROLES, ["operator", "sales", "finance", "designer"]);
  assert.deepEqual(SAM13_DANGEROUS_PATHS, [
    "/revert_passwords.py",
    "/scripts/fix-lead-customer-name.ts",
    "/scripts/seed-products.ts",
  ]);
  assert.deepEqual(
    LINEAR_IDS,
    ["SAM-11", "SAM-13", "SAM-25", "SAM-35", "SAM-49", "SAM-61"],
  );

  const [source, controller] = await Promise.all([
    readFile(new URL("../../scripts/uat/product-saas-final.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/newme-staging-control.sh", import.meta.url), "utf8"),
  ]);
  for (const contract of [
    'await recordIssue(report, "SAM-13", () => runSam13(state))',
    'for (const role of NON_MANAGEMENT_ROLES)',
    '"/api/users"',
    '`/api/users/${adminCreated.id}`',
    '`/api/users/${bossCreated.id}/password`',
    '"/api/auth/me"',
    '"/team"',
    '"inactive_account"',
    '"organization_admin_required"',
    "discoverSam13FixtureUsers",
    'state.sam13FixtureEmails.add(email)',
    '.from("audit_events")',
    'dangerous_release_paths: dangerousPaths',
    'audit_events: await exactCount(',
    'report.cleanup = "verified"',
  ]) {
    assert.ok(source.includes(contract), `SAM-13 runner is missing contract: ${contract}`);
  }
  assert.match(source, /inactive_profile:\s*\{[\s\S]*writes:\s*0/);
  assert.match(source, /non_management:\s*denied/);
  assert.match(source, /admin_boss:\s*\{[\s\S]*create:\s*2[\s\S]*password_reset:\s*2[\s\S]*deactivate:\s*2/);
  assert.match(controller, /uat-product-saas\)\s+run_uat_product_saas/);
  assert.doesNotMatch(controller, /uat-sam13|run_uat_sam13/);
});

test("SAM-25 stages one positive pipeline, six zero-write negatives, and exact cleanup", async () => {
  const [source, controller] = await Promise.all([
    readFile(new URL("../../scripts/uat/product-saas-final.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/newme-staging-control.sh", import.meta.url), "utf8"),
  ]);
  for (const contract of [
    'await recordIssue(report, "SAM-25", () => runSam25(state))',
    'stage: "solution_submitted"',
    '"positive quotation fixture did not start at the sequential predecessor stage"',
    'body: { lead_id: lead.id, devices_json: { knx_ip_router: 1 } }',
    '"hermes_unauthenticated"',
    '"draft_conversion"',
    '"finance_conversion"',
    '"duplicate_conversion"',
    '"zero_amount_payment"',
    '"operator_confirmation"',
    '.from("contract_approvals")',
    '.from("installment_plans")',
    '.from("payment_allocations")',
    '.from("projects")',
    '"quotation did not link back to the exact contract"',
    '"converted quotation did not mark the exact lead won"',
    '"project contract link drifted"',
    '"allocation payment link drifted"',
    'pipeline_notifications: await exactCount(',
    'positive_chain: {',
    'negative_matrix: negativeMatrix',
  ]) {
    assert.ok(source.includes(contract), `SAM-25 runner is missing contract: ${contract}`);
  }
  assert.ok(
    source.indexOf('stage: "solution_submitted"') <
      source.indexOf('body: { lead_id: lead.id, devices_json: { knx_ip_router: 1 } }'),
    "SAM-25 must establish the legal quotation predecessor before calling Hermes",
  );
  assert.match(
    source,
    /negativeMatrix,\s*\[\s*\{ name: "hermes_unauthenticated", status: 401, writes: 0 \}[\s\S]*\{ name: "operator_confirmation", status: 403, writes: 0 \}/,
  );
  assert.ok(
    source.indexOf('await capture("payment allocations"') <
      source.indexOf('await capture("payments"'),
    "payment allocations must be deleted before payments",
  );
  assert.ok(
    source.indexOf('await capture("break quotation contract links"') <
      source.indexOf('await capture("contracts"'),
    "quotation links must be broken before contracts are deleted",
  );
  assert.ok(
    source.indexOf('await capture("contracts"') <
      source.indexOf('await capture("quotations"'),
    "contracts must be deleted before their source quotations",
  );
  for (const contract of [
    '["hermes_unauthenticated", 401]',
    '["draft_conversion", 400]',
    '["finance_conversion", 403]',
    '["duplicate_conversion", 400]',
    '["zero_amount_payment", 400]',
    '["operator_confirmation", 403]',
    'const sam25 = body.results?.["SAM-25"]?.evidence',
    "chain.installment_plan_ids.length !== 1",
    "chain.payment_allocation_ids.length !== 1",
    "negative.length !== negativeCases.size",
    "new Set(negative.map((item) => item?.name)).size !== negativeCases.size",
    'evidence="$STATE_DIR/last-uat-product-saas.json"',
    'install -m 0600 -o root -g root "$output" "$evidence_tmp"',
  ]) {
    assert.ok(controller.includes(contract), `controller is missing SAM-25 evidence gate: ${contract}`);
  }
});
