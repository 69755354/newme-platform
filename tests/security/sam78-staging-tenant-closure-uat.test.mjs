import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CONFIRMATION,
  FIXED_MANIFEST_PATH,
  SCOPE,
  STAGING_PROJECT_REF,
  runSam78StagingTenantClosure,
  validateEnvironment,
} from "../../scripts/uat/sam78-staging-tenant-closure.mjs";

const SHA = "8".repeat(40);
const validEnvironment = {
  SAM78_EXPECTED_RELEASE_SHA: SHA,
  SAM78_BASE_URL: "http://127.0.0.1:3101",
  SAM78_RELEASE_MANIFEST: FIXED_MANIFEST_PATH,
  SAM78_UAT_CONFIRM: CONFIRMATION,
  NEWME_STAGING_PROJECT_REF: STAGING_PROJECT_REF,
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
};

test("SAM-78 environment is exact-release, loopback, fixed-project, and production-denying", () => {
  assert.equal(validateEnvironment(validEnvironment).releaseSha, SHA);
  for (const mutation of [
    { SAM78_EXPECTED_RELEASE_SHA: "main" },
    { SAM78_BASE_URL: "https://staging.newme.ae" },
    { SAM78_RELEASE_MANIFEST: "/tmp/manifest.json" },
    { SAM78_UAT_CONFIRM: "yes" },
    { NEWME_STAGING_PROJECT_REF: "vfopmpxlhwzpxqegayew" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://vfopmpxlhwzpxqegayew.supabase.co" },
  ]) {
    assert.throws(() => validateEnvironment({ ...validEnvironment, ...mutation }), /SAM78_FAIL_CLOSED/);
  }
});

test("SAM-78 report requires product lifecycle, two-tenant matrix, and verified cleanup", async () => {
  const report = await runSam78StagingTenantClosure(validEnvironment, {
    readFile: async () => JSON.stringify({ git_sha: SHA }),
    fetch: async () => ({ status: 200, json: async () => ({ status: "ok" }) }),
    runProductSaasFinalUat: async () => ({
      ok: true,
      cleanup: "verified",
      results: { "CUSTOMER-EXIT": { status: "pass" } },
    }),
    runTwoOrganizationMatrix: async () => ({
      status: "pass", organizations: 2, shared_identity_memberships: 2,
      checks: ["selected_org", "search", "direct_id", "organization_row"],
      cleanup_counts: Object.fromEntries([
        "auth_users", "profiles", "organizations", "memberships", "membership_roles",
        "leads", "audit_events", "audit_logs", "activity_logs", "activities",
      ].map((key) => [key, 0])),
    }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.scope, SCOPE);
  assert.equal(report.release.manifest_sha, SHA);
  assert.equal(report.product_lifecycle.cleanup, "verified");
  assert.equal(report.tenant_isolation.organizations, 2);
  assert.equal(report.cleanup, "verified");
});

test("SAM-78 report rejects lifecycle or cleanup shortcuts", async () => {
  const base = {
    readFile: async () => JSON.stringify({ git_sha: SHA }),
    fetch: async () => ({ status: 200, json: async () => ({ status: "ok" }) }),
    runTwoOrganizationMatrix: async () => ({ status: "pass" }),
  };
  for (const product of [
    { ok: false, cleanup: "verified", results: { "CUSTOMER-EXIT": { status: "pass" } } },
    { ok: true, cleanup: "failed", results: { "CUSTOMER-EXIT": { status: "pass" } } },
    { ok: true, cleanup: "verified", results: { "CUSTOMER-EXIT": { status: "fail" } } },
  ]) {
    await assert.rejects(
      runSam78StagingTenantClosure(validEnvironment, {
        ...base,
        runProductSaasFinalUat: async () => product,
      }),
      /product_lifecycle_prerequisite_failed/,
    );
  }
});

test("SAM-78 live implementation binds selected organization and exact cleanup", async () => {
  const source = await readFile(new URL("../../scripts/uat/sam78-staging-tenant-closure.mjs", import.meta.url), "utf8");
  for (const token of [
    '"x-newme-organization-id": organizationId',
    '.ilike("customer_name", `[SAM78 ${runId}]%`)',
    '.eq("id", foreignLead)',
    'direct_id_cross_tenant_',
    'organization_cross_tenant_',
    'selected_organization_not_visible_',
    'billable_seat_limit: 20',
    'fixture_cleanup_failed:',
    'cleanupCounts.auth_users',
    'cleanupCounts.membership_roles',
    'root.auth.admin.deleteUser(userId)',
    'runProductSaasFinalUat',
    'failureDescriptor',
    'unexpected_runner_error',
    'runner_origin',
  ]) assert.match(source, new RegExp(token.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const forbiddenEnvRead = new RegExp(
    "console\\.log|process\\.env\\.(?:SUPABASE_SERVICE_ROLE_" +
      "KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY)",
  );
  assert.doesNotMatch(source, forbiddenEnvRead);
});
