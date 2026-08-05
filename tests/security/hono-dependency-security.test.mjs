import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("production dependency graph excludes the unused shadcn MCP and Hono toolchain", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const packageLockText = await read("package-lock.json");
  const packageLock = JSON.parse(packageLockText);

  assert.equal(packageJson.packageManager, "npm@11.16.0");
  assert.equal(packageJson.dependencies.shadcn, undefined);
  assert.equal(packageJson.dependencies.hono, undefined);
  for (const packagePath of [
    "node_modules/shadcn",
    "node_modules/@modelcontextprotocol/sdk",
    "node_modules/@hono/node-server",
    "node_modules/hono",
  ]) {
    assert.equal(packageLock.packages[packagePath], undefined, packagePath);
  }
});

test("Next API boundaries remain the authenticated Case path without Hono middleware", async () => {
  const [nextConfig, instrumentation, leadsList, stageRoute] = await Promise.all([
    read("next.config.ts"),
    read("instrumentation.ts"),
    read("src/app/api/leads/list/route.ts"),
    read("src/app/api/leads/[id]/stage/route.ts"),
  ]);
  const runtimeSources = [nextConfig, instrumentation, leadsList, stageRoute];

  for (const source of runtimeSources) {
    assert.doesNotMatch(source, /(?:from|require\s*\()\s*["'](?:@hono\/|hono(?:["'/]))/);
  }
  assert.match(nextConfig, /NEXT_PUBLIC_SITE_URL/);
  assert.doesNotMatch(nextConfig, /Access-Control-Allow-Origin[^\n]*["']\*["']/);
  assert.match(leadsList, /if \(!user\)/);
  assert.match(leadsList, /role === "sales"/);
  assert.match(leadsList, /getVisibleLeadOwnerIds\(leads \|\| \[\]\)/);
  assert.match(stageRoute, /Forbidden: lead not assigned to you/);
  assert.match(stageRoute, /Invalid stage/);
  assert.match(stageRoute, /return respond\(\{ success: true/);
});
