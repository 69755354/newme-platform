import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const routes = new Map([
  ["src/app/api/leads/[id]/assignment/route.ts", 1],
  ["src/app/api/leads/[id]/contacts/route.ts", 1],
  ["src/app/api/leads/[id]/contacts/[contactId]/route.ts", 2],
  ["src/app/api/leads/[id]/delete/route.ts", 1],
  ["src/app/api/leads/[id]/milestone/route.ts", 2],
  ["src/app/api/leads/[id]/notes/route.ts", 1],
  ["src/app/api/leads/[id]/quality/route.ts", 1],
  ["src/app/api/leads/[id]/stage/route.ts", 1],
  ["src/app/api/leads/[id]/transfer-history/route.ts", 1],
  ["src/app/api/quotations/generate/route.ts", 1],
  ["src/app/api/tasks/route.ts", 3],
  ["src/app/api/tasks/[id]/route.ts", 2],
  ["src/app/api/tasks/list/route.ts", 1],
]);

test("request-scoped mutation routes reuse exactly one auth client per handler", async () => {
  for (const [path, handlerCount] of routes) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.equal(
      (source.match(/getRequestAuthContext\((?:req|request)\)/g) ?? []).length,
      handlerCount,
      `${path} must resolve one auth context per handler`,
    );
    assert.doesNotMatch(source, /getAuthProfile|canAccessLead|createServerSupabase/);
    assert.match(source, /applyRequestAuthCookies/);
    assert.match(source, /requestAuthErrorResponse/);
  }
});

test("request auth errors clear revoked sessions without masking upstream outages", async () => {
  const source = await readFile(new URL("src/lib/request-auth-context.ts", root), "utf8");

  assert.match(source, /refreshFailure === "invalid_refresh_token"/);
  assert.match(source, /refreshFailure === "missing_refresh_token"/);
  assert.match(source, /response\.cookies\.set\(name, "", \{ path: "\/", maxAge: 0 \}\)/);
  assert.match(source, /refreshFailure === "upstream_error"/);
  assert.match(source, /new RequestAuthError\("auth_unavailable", \{ refreshedCookies \}\)/);
  assert.match(source, /for \(const cookie of error\.refreshedCookies\)/);
});
