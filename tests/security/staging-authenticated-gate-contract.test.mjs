import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("staging authenticated gate is target-bound, setup-dependent, and covers positive plus denied roles", async () => {
  const [config, setup, gate] = await Promise.all([
    read("playwright.config.ts"),
    read("e2e/auth.setup.ts"),
    read("e2e/staging-authenticated-gate.spec.ts"),
  ]);

  assert.match(config, /E2E_STAGING_ONLY/);
  assert.match(config, /staging\.newme\.ae/);
  assert.match(config, /E2E_EXPECTED_SHA/);
  assert.match(config, /name:\s*["']auth-setup["']/);
  assert.match(config, /dependencies:\s*\[["']auth-setup["']\]/);
  assert.match(setup, /boss\.json/);
  assert.match(setup, /sales\.json/);
  assert.match(gate, /\/api\/health/);
  assert.match(gate, /E2E_EXPECTED_SHA/);
  assert.match(gate, /\/api\/auth\/me/);
  assert.match(gate, /testInfo\.project\.name === ["']boss["']/);
  assert.match(gate, /testInfo\.project\.name === ["']sales["']/);
  assert.match(gate, /\/team/);
  assert.doesNotMatch(gate, /E2E_ALLOW_PRODUCTION/);
});
