import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const runnerRoot = resolve(root, "infra/staging/uat-runner");
const productionRef = "vfopmpxlhwzpxqegayew";
const stagingRef = "bfsiibofuzoglziltgyd";

test("staging UAT runner uses a pinned browser image and pinned package", async () => {
  const [dockerfile, manifestRaw, lockRaw, uatScript] = await Promise.all([
    readFile(resolve(runnerRoot, "Dockerfile"), "utf8"),
    readFile(resolve(runnerRoot, "package.json"), "utf8"),
    readFile(resolve(runnerRoot, "package-lock.json"), "utf8"),
    readFile(resolve(root, "scripts/verify-staging-sam26-roles.mjs"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const lock = JSON.parse(lockRaw);

  assert.equal(manifest.dependencies.playwright, "1.60.0");
  assert.equal(lock.packages["node_modules/playwright"].version, "1.60.0");
  assert.equal(lock.packages["node_modules/playwright-core"].version, "1.60.0");
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:v1\.60\.0-noble$/m);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /USER pwuser/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/runner\/verify-staging-sam26-roles\.mjs"\]/);
  assert.doesNotMatch(dockerfile, new RegExp(productionRef));
  assert.match(uatScript, new RegExp(`const CLEANROOM_REF = "${stagingRef}"`));
  assert.match(uatScript, new RegExp(`const PRODUCTION_REF = "${productionRef}"`));
});
