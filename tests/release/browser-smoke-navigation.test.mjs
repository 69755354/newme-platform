import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const smoke = await readFile(
  new URL("../../scripts/check-browser-smoke.ts", import.meta.url),
  "utf8",
);

test("browser smoke separates route readiness from optional network-idle settling", () => {
  assert.match(smoke, /waitUntil:\s*"domcontentloaded"/);
  assert.match(smoke, /waitForLoadState\("networkidle".*catch/s);
  assert.doesNotMatch(
    smoke,
    /page\.goto\([^)]*\{[\s\S]*?waitUntil:\s*"networkidle"/,
  );
});

test("browser smoke supports an isolated staging target and report path", () => {
  assert.match(smoke, /BROWSER_SMOKE_BASE_URL/);
  assert.match(smoke, /BROWSER_SMOKE_REPORT_PATH/);
  assert.match(smoke, /finalUrl/);
  assert.match(smoke, /durationMs/);
});
