import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("scripts/uat/sam80-shared-operational-services.mjs", "utf8");

test("SAM-80 staging runner never accepts production or unbound releases", () => {
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(source, /manifest\.git_sha !== expectedSha/);
  assert.match(source, /health\.status !== 200/);
});

test("SAM-80 staging runner uses exact identifiers for reverse cleanup", () => {
  assert.match(source, /created = \{/);
  assert.match(source, /\.in\("id", ids\)/);
  assert.match(source, /cleanup_residue_detected/);
  assert.doesNotMatch(source, /truncate|delete\(\)\.neq/i);
});
