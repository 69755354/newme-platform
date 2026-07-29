import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runner = await readFile(
  new URL("../../scripts/verify-local-sam66-auth-regression.mjs", import.meta.url),
  "utf8",
);

test("SAM-66 is loopback-only, marker-scoped, and runs twice", () => {
  assert.match(runner, /\["127\.0\.0\.1", "localhost"\]/);
  assert.match(runner, /SAM66_RUNS must be exactly 2/);
  assert.match(runner, /fixture_scope: "sam66-local-auth-regression"/);
  assert.match(runner, /fixture_kind: "auth-gate"/);
  assert.match(runner, /for \(let index = 1; index <= RUNS; index \+= 1\)/);
  assert.match(runner, /auth: usersLeft\.length/);
  for (const table of [
    "profiles",
    "leads",
    "activities",
    "tasks",
    "business_events",
    "notifications",
  ]) {
    assert.match(runner, new RegExp(`${table}:`));
  }
});

test("SAM-66 exercises credentials, refresh, roles, UI, and ownership denial", () => {
  for (const actor of ["boss", "admin", "operator", "sales", "sales-other"]) {
    assert.match(runner, new RegExp(`"${actor}"`));
  }
  assert.match(runner, /signInWithPassword/);
  assert.match(runner, /refreshSession/);
  assert.match(runner, /chromium\.launch/);
  assert.match(runner, /cross-owner note denial/);
  assert.match(runner, /First Contact/);
  assert.match(runner, /timeline contact edit/);
  assert.match(runner, /timeline contact delete/);
  assert.match(runner, /won-lost/);
});

test("SAM-66 fails closed without browser coverage and never auto-installs", () => {
  assert.doesNotMatch(runner, /playwright", "install"|execFileSync/);
  assert.match(runner, /browser coverage unavailable/);
  assert.match(runner, /REPORT\.ok = true/);
  assert.doesNotMatch(runner, /storageState|screenshot|trace\s*:/i);
  assert.match(runner, /console\.log\(JSON\.stringify\(REPORT\)\)/);
  assert.match(runner, /safeText\(error\.message\)/);
});
