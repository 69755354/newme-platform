import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_REF,
  REQUEST_TIMEOUT_MS,
  STAGING_REF,
  parseEnvironmentFile,
  runSam27StagingUat,
} from "../../scripts/verify-staging-sam27-integrations.mjs";

const releaseSha = "c".repeat(40);
const releaseRoot = `/opt/newme-staging/releases/${releaseSha}`;

function dependencies({
  metaConfigured = false,
  disabledStatus = 503,
  healthBody = { status: "ok" },
} = {}) {
  const calls = [];
  const environmentFile = [
    `NEWME_STAGING_PROJECT_REF=${STAGING_REF}`,
    `NEXT_PUBLIC_SUPABASE_URL=https://${STAGING_REF}.supabase.co`,
    `META_APP_ID=${metaConfigured ? "forbidden" : ""}`,
    "META_APP_SECRET=",
    "META_REDIRECT_URI=",
    "META_CAPI_WEBHOOK_SECRET=",
  ].join("\n");
  return {
    calls,
    environment: { SAM27_EXPECTED_RELEASE_SHA: releaseSha },
    realpath: async (path) => {
      assert.equal(path, "/opt/newme-staging/current");
      return releaseRoot;
    },
    readFile: async (path) => {
      if (path === `${releaseRoot}/manifest.json`) {
        return JSON.stringify({ git_sha: releaseSha });
      }
      if (path === "/etc/newme-staging/staging.env") return environmentFile;
      assert.fail(`unexpected read ${path}`);
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(url.startsWith("http://127.0.0.1:3101/"), true);
      assert.equal(url.includes("app.newme.ae"), false);
      assert.equal(init.signal instanceof AbortSignal, true);
      if (url.endsWith("/api/health")) {
        return Response.json(healthBody, {
          status: 200,
          headers: { "cache-control": "no-store, max-age=0" },
        });
      }
      const integration = url.includes("meta-capi") ? "meta_capi" : "meta_oauth";
      return Response.json(
        { status: "disabled", integration, reason: "not_configured" },
        {
          status: disabledStatus,
          headers: { "cache-control": "no-store, max-age=0" },
        },
      );
    },
  };
}

test("SAM-27 runner emits SHA-bound disabled and synthetic execution evidence", async () => {
  const deps = dependencies();
  const evidence = await runSam27StagingUat(deps);

  assert.equal(REQUEST_TIMEOUT_MS, 3_000);
  assert.equal(evidence.releaseSha, releaseSha);
  assert.deepEqual(evidence.health, {
    status: "passed",
    httpStatus: 200,
    responseFields: ["status"],
  });
  assert.deepEqual(evidence.disabledIntegrations, {
    metaOAuthStart: { status: "disabled", httpStatus: 503 },
    metaOAuthCallback: { status: "disabled", httpStatus: 503 },
    metaCapi: { status: "disabled", httpStatus: 503 },
    productionCallbackContacted: false,
  });
  assert.deepEqual(evidence.syntheticExecution.recovered, {
    status: "passed",
    attempts: 2,
    auditOutcomes: ["retry", "success"],
    finalAlerts: 0,
  });
  assert.deepEqual(evidence.syntheticExecution.terminal, {
    status: "passed",
    attempts: 1,
    auditOutcomes: ["failure"],
    finalAlerts: 1,
  });
  assert.deepEqual(evidence.syntheticExecution.exhausted, {
    status: "passed",
    attempts: 3,
    auditOutcomes: ["retry", "retry", "failure"],
    finalAlerts: 1,
  });
  assert.deepEqual(evidence.cleanup, {
    status: "not_applicable",
    reason: "read_only_disabled_routes_and_in_process_synthetic_contract",
    fixtureIds: [],
  });

  assert.equal(deps.calls.length, 4);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(PRODUCTION_REF), false);
  assert.equal(serialized.includes("META_APP_SECRET"), false);
});

test("SAM-27 runner fails closed if Meta is configured or a route is not disabled", async () => {
  await assert.rejects(
    runSam27StagingUat(dependencies({ metaConfigured: true })),
    /meta_must_be_disabled_in_staging/,
  );
  await assert.rejects(
    runSam27StagingUat(dependencies({ disabledStatus: 401 })),
    /meta_oauth_disabled_contract_failed/,
  );
});

test("SAM-27 runner rejects public health detail and parses env literally", async () => {
  await assert.rejects(
    runSam27StagingUat(
      dependencies({ healthBody: { status: "ok", database: "UP" } }),
    ),
    /public_health_contract_failed/,
  );
  assert.deepEqual(
    parseEnvironmentFile("A='literal value'\nB=$(not-executed)\n"),
    { A: "literal value", B: "$(not-executed)" },
  );
});
