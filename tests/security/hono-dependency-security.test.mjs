import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("production lockfiles pin the transitive Hono dependency to the patched release", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const packageLockText = await read("package-lock.json");
  const packageLock = JSON.parse(packageLockText);
  const pnpmLock = await read("pnpm-lock.yaml");
  const lockedHono = packageLock.packages["node_modules/hono"];

  assert.equal(packageJson.dependencies.hono, undefined);
  assert.deepEqual(
    {
      version: lockedHono.version,
      resolved: lockedHono.resolved,
      integrity: lockedHono.integrity,
    },
    {
      version: "4.12.27",
      resolved: "https://registry.npmjs.org/hono/-/hono-4.12.27.tgz",
      integrity:
        "sha512-1yrb/+w6HWQJrUCLkJ2IF5jNIPvvFkblV5RNOYl6bV+OA6p9GLcMpHFFGTosSvHvcAUibuUukRqhlYI4z32C7Q==",
    },
  );
  assert.match(pnpmLock, /^  hono@4\.12\.27:/m);
  assert.match(pnpmLock, /  hono@4\.12\.27: \{\}/);
  assert.doesNotMatch(packageLockText, /hono-4\.12\.(?:23|24)\.tgz/);
  assert.doesNotMatch(pnpmLock, /hono@4\.12\.(?:23|24)\b/);
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
  assert.match(stageRoute, /return NextResponse\.json\(\{ success: true/);
});
