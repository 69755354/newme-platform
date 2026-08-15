import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("npm test uses the cross-platform Node test launcher", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts.test, "node scripts/run-node-tests.mjs");
  const launcher = await readFile(new URL("../../scripts/run-node-tests.mjs", import.meta.url), "utf8");
  assert.match(launcher, /process\.execPath/);
  assert.match(launcher, /globSync\("tests\/\*\*\/\*\.test\.mjs"\)/);
  assert.match(launcher, /includes\("Module\._load"\)/);
  assert.match(launcher, /"--test", "--test-concurrency=1", "--test-isolation=process", \.\.\.files/);
  assert.match(launcher, /Git", "bin"/);
});

test("npm test discovers the executable auth/me regression suite", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts.test, "node scripts/run-node-tests.mjs");
  await access(new URL("./auth-me.test.mjs", import.meta.url));
  await assert.rejects(access(new URL("./auth-me.test.ts", import.meta.url)));
});

test("shell-backed repository gates use the cross-platform Bash launcher", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  for (const name of [
    "check:route-files",
    "check:smoke",
    "check:logs",
    "check:pre-release",
    "check:staging-boundaries",
  ]) {
    assert.match(packageJson.scripts[name], /^node scripts\/run-bash\.mjs /);
  }
  assert.equal(packageJson.scripts["check:workflows"], "node scripts/check-workflows-yaml.mjs");
  assert.match(
    packageJson.scripts["check:definer-rpc-allowlist"],
    /sam61-definer-boundaries\.test\.mjs.*sam62-transition-definer-search-path\.test\.mjs/,
  );
  await access(new URL("../../scripts/check-workflows-yaml.mjs", import.meta.url));
  await access(new URL("../../scripts/run-bash.mjs", import.meta.url));
});
