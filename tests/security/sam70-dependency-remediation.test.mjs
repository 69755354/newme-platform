import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const rootUrl = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, rootUrl), "utf8");

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  assert.ok(match, `expected an exact semver, received ${value}`);
  return match.slice(1).map(Number);
}

function atLeast(actual, expected) {
  const actualParts = parseVersion(actual);
  const expectedParts = parseVersion(expected);
  return actualParts.some(
    (part, index) =>
      part > expectedParts[index] &&
      actualParts.slice(0, index).every((value, prior) => value === expectedParts[prior]),
  ) || actualParts.every((part, index) => part === expectedParts[index]);
}

test("SAM-70 lockfile contains only remediated PostCSS and sharp releases", async () => {
  const packageLock = JSON.parse(await read("package-lock.json"));
  const versions = Object.entries(packageLock.packages)
    .filter(([packagePath]) => /(?:^|\/)node_modules\/(?:postcss|sharp)$/.test(packagePath))
    .map(([packagePath, metadata]) => [packagePath, metadata.version]);

  assert.ok(versions.some(([packagePath]) => packagePath.endsWith("/postcss")));
  assert.ok(versions.some(([packagePath]) => packagePath.endsWith("/sharp")));

  for (const [packagePath, version] of versions) {
    const minimum = packagePath.endsWith("/postcss") ? "8.5.18" : "0.35.0";
    assert.ok(atLeast(version, minimum), `${packagePath} must be >= ${minimum}, received ${version}`);
  }
});

test("SAM-70 keeps the canonical toolchain and isolates the unused MCP graph", async () => {
  const [packageJson, packageLock, globalCss] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("package-lock.json").then(JSON.parse),
    read("src/app/globals.css"),
  ]);

  assert.equal(packageJson.packageManager, "npm@11.16.0");
  assert.deepEqual(packageJson.engines, { node: "24.18.0", npm: "11.16.0" });
  assert.equal(packageJson.dependencies.shadcn, undefined);
  assert.equal(packageLock.packages[""].dependencies.shadcn, undefined);

  for (const packagePath of [
    "node_modules/shadcn",
    "node_modules/@modelcontextprotocol/sdk",
    "node_modules/@hono/node-server",
    "node_modules/hono",
  ]) {
    assert.equal(packageLock.packages[packagePath], undefined, packagePath);
  }

  await assert.rejects(access(new URL("pnpm-lock.yaml", rootUrl)));
  assert.doesNotMatch(globalCss, /@import\s+["']shadcn\//);
  for (const variant of [
    "data-open",
    "data-closed",
    "data-disabled",
    "data-active",
    "data-horizontal",
    "data-vertical",
  ]) {
    assert.match(globalCss, new RegExp(`@custom-variant ${variant}\\b`));
  }
});
