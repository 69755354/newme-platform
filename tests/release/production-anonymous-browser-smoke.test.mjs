import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const metaPixel = readFileSync(new URL("../../src/components/MetaPixel.tsx", import.meta.url), "utf8");
const nextConfig = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
const productionConfig = readFileSync(
  new URL("../../playwright.production-smoke.config.ts", import.meta.url),
  "utf8",
);
const productionSpec = readFileSync(
  new URL("../../e2e/production-anonymous.spec.ts", import.meta.url),
  "utf8",
);
const accountConfig = readFileSync(new URL("../../playwright.config.ts", import.meta.url), "utf8");
const accountSetupConfig = readFileSync(
  new URL("../../e2e/playwright.config.ts", import.meta.url),
  "utf8",
);

test("authentication pages do not widen CSP or load Meta Pixel", () => {
  assert.match(metaPixel, /const NO_PIXEL_PATHS = \[[\s\S]*"\/login",[\s\S]*"\/change-password",/);
  assert.match(metaPixel, /excludedPaths = NO_PIXEL_PATHS/);
  assert.doesNotMatch(nextConfig, /connect\.facebook\.net/);
});

test("anonymous production smoke owns a loopback build and start lifecycle", () => {
  assert.match(productionConfig, /hostname !== "127\.0\.0\.1"/);
  assert.match(productionConfig, /npm run build && npm run start/);
  assert.match(productionConfig, /reuseExistingServer: false/);
  assert.match(productionConfig, /NEXT_PUBLIC_SUPABASE_URL: "http:\/\/127\.0\.0\.1:54321"/);
  assert.match(productionConfig, /testMatch: \/production-anonymous\\\.spec\\\.ts\//);
});

test("anonymous smoke strictly covers release boundaries and browser errors", () => {
  assert.match(productionSpec, /expect\(health\.status\(\)\)\.toBe\(200\)/);
  assert.match(productionSpec, /expect\(root\.status\(\)\)\.toBe\(307\)/);
  assert.match(productionSpec, /expect\(authMe\.status\(\)\)\.toBe\(401\)/);
  assert.match(productionSpec, /expect\(pageErrors,[\s\S]*\)\.toEqual\(\[\]\)/);
  assert.match(productionSpec, /expect\(consoleErrors,[\s\S]*\)\.toEqual\(\[\]\)/);
});

test("account E2E retains its explicit production opt-in guard", () => {
  assert.match(accountConfig, /hostname === 'app\.newme\.ae'/);
  assert.match(accountConfig, /E2E_ALLOW_PRODUCTION !== '1'/);
  assert.match(accountConfig, /testIgnore: \/production-anonymous\\\.spec\\\.ts\//);
  assert.match(accountSetupConfig, /testIgnore: \/production-anonymous\\\.spec\\\.ts\//);
});
