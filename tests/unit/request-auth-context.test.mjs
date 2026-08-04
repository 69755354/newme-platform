/**
 * Request-auth context regression tests.
 *
 * This uses only Node's stable test runner so it executes under the
 * repository-wide `npm test` command without experimental module mocks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path) {
  return readFileSync(path, "utf8");
}

test("request auth context keeps explicit request, timeout, typed failures, and refresh propagation", () => {
  const context = source("src/lib/request-auth-context.ts");

  assert.match(context, /createServerSupabase\(\s*extractBearerToken\(request\),\s*request\.headers\.get\("cookie"\) \?\? ""/s);
  assert.match(context, /const AUTH_TIMEOUT_MS = 3_000/);
  assert.match(context, /new RequestAuthError\("unauthorized"\)/);
  assert.match(context, /new RequestAuthError\("inactive_account"\)/);
  assert.match(context, /new RequestAuthError\("auth_unavailable"\)/);
  assert.match(context, /new RequestAuthError\("profile_unavailable"\)/);
  assert.match(context, /response\.cookies\.set\(/);
});

test("high-risk impersonation route uses one context boundary and preserves refreshed cookies", () => {
  const route = source("src/app/api/admin/impersonate/route.ts");

  assert.match(route, /getRequestAuthContext\(request\)/);
  assert.doesNotMatch(route, /createServerSupabase/);
  assert.equal((route.match(/getRequestAuthContext\(/g) ?? []).length, 1);
  assert.match(route, /applyRequestAuthCookies\(context,/);
});

test("quality route uses one auth context, preserves refreshed cookies, and logs denied access", () => {
  const route = source("src/app/api/leads/[id]/quality/route.ts");

  assert.match(route, /getRequestAuthContext\(req\)/);
  assert.doesNotMatch(route, /createServerSupabase/);
  assert.doesNotMatch(route, /getAuthProfile/);
  assert.match(route, /applyRequestAuthCookies\(context, NextResponse\.json/);
  assert.match(route, /quality update lead was not visible to authenticated user/);
});
