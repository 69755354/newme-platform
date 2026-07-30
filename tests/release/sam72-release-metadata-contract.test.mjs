import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("../integration/sam68-next-route-loader.mjs", import.meta.url);

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const readiness = await import("../../src/app/api/ready/route.ts");

function assertReleaseMetadataContract({
  config,
  build,
  logger,
  ready,
  health,
}) {
  for (const token of [
    'const stagingReleaseSha = process.env.NEXT_PUBLIC_APP_VERSION || ""',
    "isStandaloneBuild && !/^[0-9a-f]{40}$/.test(stagingReleaseSha)",
    "NEWME_RELEASE_SHA: stagingReleaseMetadata",
    "NEWME_BUILD_ID: stagingReleaseMetadata",
    'NEWME_RELEASE_METADATA_REQUIRED: isStandaloneBuild ? "1" : "0"',
    "generateBuildId: isStandaloneBuild",
    "async () => stagingReleaseSha",
  ]) assert.ok(config.includes(token), `missing build metadata contract: ${token}`);

  const releaseExport = build.indexOf('export NEXT_PUBLIC_APP_VERSION="$SHA"');
  const nextBuild = build.indexOf("npm run build -- --webpack");
  const manifestWrite = build.indexOf('printf \'{"git_sha":"%s","created_at":"%s"}');
  assert.ok(releaseExport >= 0 && releaseExport < nextBuild);
  assert.ok(nextBuild < manifestWrite);

  assert.match(logger, /process\.env\.NEWME_RELEASE_SHA \|\|\s+process\.env\.BUILD_ID/);
  assert.match(logger, /process\.env\.NEWME_BUILD_ID \|\|\s+process\.env\.BUILD_ID/);

  assert.match(ready, /NEWME_RELEASE_METADATA_REQUIRED !== "1"/);
  assert.match(ready, /releaseSha !== buildId/);
  assert.match(ready, /if \(releaseMetadata === false\)/);
  assert.match(ready, /release_sha: releaseSha, build_id: buildId/);
  assert.match(ready, /\.\.\.\(releaseMetadata \|\| \{\}\)/);

  assert.equal(health.replaceAll("\r\n", "\n"), `// RBAC: public
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

export function GET() {
  return NextResponse.json({
    status: "ok",
  }, { headers: noStoreHeaders });
}
`);
}

const loadContract = async () => {
  const [config, build, logger, ready, health] = await Promise.all([
    read("next.config.ts"),
    read("scripts/build-staging-artifact.sh"),
    read("src/lib/logger.ts"),
    read("src/app/api/ready/route.ts"),
    read("src/app/api/health/route.ts"),
  ]);
  return { config, build, logger, ready, health };
};

test("SAM-72 staging release SHA becomes the exact build ID used by logs and authenticated readiness", async () => {
  assertReleaseMetadataContract(await loadContract());
});

test("SAM-72 release metadata gate rejects missing, bypassed, and public metadata", async (t) => {
  const contract = await loadContract();

  await t.test("rejects removal of deterministic Next build IDs", () => {
    assert.throws(() => assertReleaseMetadataContract({
      ...contract,
      config: contract.config.replace(
        "generateBuildId: isStandaloneBuild",
        "generateBuildId: false && isStandaloneBuild",
      ),
    }));
  });

  await t.test("rejects a non-exact standalone release SHA gate", () => {
    assert.throws(() => assertReleaseMetadataContract({
      ...contract,
      config: contract.config.replace(
        "isStandaloneBuild && !/^[0-9a-f]{40}$/.test(stagingReleaseSha)",
        "isStandaloneBuild && !stagingReleaseSha",
      ),
    }));
  });

  await t.test("rejects authenticated readiness metadata bypass", () => {
    assert.throws(() => assertReleaseMetadataContract({
      ...contract,
      ready: contract.ready.replace(
        "releaseMetadata === false",
        "false && releaseMetadata === false",
      ),
    }));
  });

  await t.test("rejects release metadata on the public health route", () => {
    assert.throws(() => assertReleaseMetadataContract({
      ...contract,
      health: contract.health.replace(
        'status: "ok",',
        'status: "ok", release_sha: process.env.NEWME_RELEASE_SHA,',
      ),
    }));
  });
});

test("SAM-72 authenticated staging readiness returns exact metadata and fails closed before probing on drift", async (t) => {
  const keys = [
    "NEWME_READINESS_TOKEN",
    "NEWME_RELEASE_METADATA_REQUIRED",
    "NEWME_RELEASE_SHA",
    "NEWME_BUILD_ID",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const originalEnvironment = new Map(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
  });

  const sha = "a".repeat(40);
  process.env.NEWME_READINESS_TOKEN = "sam72-readiness-token";
  process.env.NEWME_RELEASE_METADATA_REQUIRED = "1";
  process.env.NEWME_RELEASE_SHA = sha;
  process.env.NEWME_BUILD_ID = sha;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://upstream.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-service-key";
  let probeCount = 0;
  globalThis.fetch = async () => {
    probeCount += 1;
    return new Response("[]", { status: 200 });
  };

  const request = () => new Request("https://local.test/api/ready", {
    headers: { "x-newme-readiness-token": "sam72-readiness-token" },
  });
  const ready = await readiness.GET(request());
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: "ready",
    release_sha: sha,
    build_id: sha,
  });
  assert.equal(probeCount, 1);

  process.env.NEWME_BUILD_ID = "b".repeat(40);
  const degraded = await readiness.GET(request());
  assert.equal(degraded.status, 503);
  assert.deepEqual(await degraded.json(), { status: "degraded" });
  assert.equal(probeCount, 1, "metadata drift must fail before the upstream readiness probe");
});
