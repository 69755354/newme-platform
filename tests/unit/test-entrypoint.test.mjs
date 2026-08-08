import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("npm test passes the recursive test glob to Node instead of the shell", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts.test, 'node --test "tests/**/*.test.mjs"');
});
