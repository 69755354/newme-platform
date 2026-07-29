import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const runnerRoot = resolve(root, "infra/staging/uat-runner");
const productionRef = "vfopmpxlhwzpxqegayew";
const stagingRef = "bfsiibofuzoglziltgyd";

test("staging UAT runner uses pinned and fail-closed browser dependencies", async () => {
  const [
    dockerfile,
    manifestRaw,
    lockRaw,
    runner,
    sam26Script,
    sam70Script,
  ] = await Promise.all([
    readFile(resolve(runnerRoot, "Dockerfile"), "utf8"),
    readFile(resolve(runnerRoot, "package.json"), "utf8"),
    readFile(resolve(runnerRoot, "package-lock.json"), "utf8"),
    readFile(resolve(runnerRoot, "run.sh"), "utf8"),
    readFile(resolve(root, "scripts/verify-staging-sam26-roles.mjs"), "utf8"),
    readFile(resolve(root, "scripts/verify-staging-sam70-xlsx.mjs"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const lock = JSON.parse(lockRaw);

  assert.equal(manifest.dependencies.playwright, "1.60.0");
  assert.equal(
    manifest.dependencies.xlsx,
    "https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz",
  );
  assert.equal(lock.packages["node_modules/playwright"].version, "1.60.0");
  assert.equal(lock.packages["node_modules/playwright-core"].version, "1.60.0");
  assert.equal(lock.packages["node_modules/xlsx"].version, "0.20.2");
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:v1\.60\.0-noble$/m);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /USER pwuser/);
  assert.match(dockerfile, /ENTRYPOINT \["\/runner\/run\.sh"\]/);
  assert.match(
    dockerfile,
    /COPY verify-staging-sam70-xlsx\.mjs \/runner\/verify-staging-sam70-xlsx\.mjs/,
  );
  assert.doesNotMatch(dockerfile, new RegExp(productionRef));
  assert.match(runner, new RegExp(`readonly STAGING_REF="${stagingRef}"`));
  assert.match(runner, new RegExp(`readonly PRODUCTION_REF="${productionRef}"`));
  assert.match(runner, /refusing non-staging project/);
  assert.match(runner, /refusing non-staging Supabase URL/);
  assert.match(runner, /refusing non-staging application URL/);
  assert.match(runner, /SAM26_RELEASE_MANIFEST/);
  assert.match(runner, /\/runner\/release\/manifest\.json/);
  assert.match(runner, /SAM_UAT_SUITE/);
  assert.match(runner, /sam26\)/);
  assert.match(runner, /sam70\)/);
  assert.match(runner, /SAM70_UAT_CONFIRM/);
  assert.match(runner, /exec node \/runner\/verify-staging-sam70-xlsx\.mjs/);
  assert.match(sam26Script, /releaseManifest\?\.git_sha/);
  assert.match(sam26Script, new RegExp(`const CLEANROOM_REF = "${stagingRef}"`));
  assert.match(sam26Script, new RegExp(`const PRODUCTION_REF = "${productionRef}"`));
  assert.match(sam70Script, new RegExp(`const STAGING_REF = "${stagingRef}"`));
  assert.match(sam70Script, new RegExp(`const PRODUCTION_REF = "${productionRef}"`));
  assert.match(sam70Script, /SAM70_UAT_CONFIRM/);
  assert.match(sam70Script, /\/runner\/release\/manifest\.json/);
});
