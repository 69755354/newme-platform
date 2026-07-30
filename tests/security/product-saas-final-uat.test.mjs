import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONFIRMATION,
  FIXED_MANIFEST_PATH,
  LINEAR_IDS,
  PRODUCTION_PROJECT_REF,
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
    "Unknown device_ids",
    "Quotation total must be greater than zero",
    "next_quote_no",
    "audit_logs",
    "user_session_daily",
    "x-newme-organization-id",
    "@invalid.test",
    'report.cleanup = "verified"',
  ]) {
    assert.ok(source.includes(contract), `runner is missing contract marker: ${contract}`);
  }
  assert.ok(source.includes('app_metadata: {'), "fixture ownership must use app_metadata");
  assert.ok(source.includes("run_id: state.runId"), "fixture app_metadata must include run_id");
  assert.ok(source.includes("redirect: \"manual\""), "release checks must not follow redirects");
  assert.ok(!source.includes("console.log("), "runner must not log credential-bearing state");
});
