import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("quality route uses one request auth context for auth and RLS", () => {
  const route = source("src/app/api/leads/[id]/quality/route.ts");

  assert.equal((route.match(/getRequestAuthContext\(req\)/g) ?? []).length, 1);
  assert.doesNotMatch(route, /createServerSupabase/);
  assert.doesNotMatch(route, /getAuthProfile/);
  assert.match(route, /applyRequestAuthCookies\(context, NextResponse\.json/);
  assert.match(route, /lead\.assigned_to !== context\.user\.id/);
  assert.match(route, /quality update lead was not visible to authenticated user/);
});

test("production rollback reasons satisfy the service-control token contract", () => {
  const rollback = source("infra/systemd/newme-production-rollback.sh");

  assert.match(rollback, /automatic-rollback-recovery:candidate-verification-failed/);
  assert.match(rollback, /safe_reason=\$\{reason\/\/\[\^A-Za-z0-9\._:/);
  assert.match(rollback, /production-rollback:\$safe_reason/);
  assert.doesNotMatch(rollback, /production rollback:/);
});
