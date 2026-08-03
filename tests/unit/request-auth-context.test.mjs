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

test("retired impersonation route cannot enter an authentication or service-client path", () => {
  const route = source("src/app/api/admin/impersonate/route.ts");

  assert.match(route, /export async function POST\(\)/);
  assert.match(route, /status: 410/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(
    route,
    /getRequestAuthContext|applyRequestAuthCookies|createServerSupabase|supabaseAdmin|generateLink/,
  );
});
