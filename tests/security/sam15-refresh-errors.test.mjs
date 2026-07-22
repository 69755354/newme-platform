import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { classifyRefreshFailure } from "../../src/lib/auth-refresh.mjs";

const root = new URL("../../", import.meta.url);

test("refresh_token_not_found is an expected invalid-session failure", () => {
  assert.equal(
    classifyRefreshFailure(400, { code: "refresh_token_not_found", message: "Refresh Token Not Found" }),
    "invalid_refresh_token",
  );
  assert.equal(
    classifyRefreshFailure(400, { error: "invalid_grant", message: "Invalid refresh token" }),
    "invalid_refresh_token",
  );
});

test("unexpected refresh responses remain upstream failures", () => {
  assert.equal(classifyRefreshFailure(500, { message: "temporary auth outage" }), "upstream_error");
  assert.equal(classifyRefreshFailure(400, { code: "unknown_error" }), "upstream_error");
});

test("auth route cleans expected refresh failures and logs only upstream refresh failures", async () => {
  const [refreshClassifier, server, authMe] = await Promise.all([
    readFile(new URL("src/lib/auth-refresh.mjs", root), "utf8"),
    readFile(new URL("src/lib/supabase-server.ts", root), "utf8"),
    readFile(new URL("src/app/api/auth/me/route.ts", root), "utf8"),
  ]);

  assert.match(server, /getRefreshFailure/);
  assert.match(refreshClassifier, /refresh_token_not_found/);
  assert.match(authMe, /clearSessionCookies\(response\)/);
  assert.match(authMe, /refreshFailure === "invalid_refresh_token"/);
  assert.match(authMe, /refreshFailure === "missing_refresh_token"/);

  const upstreamBranchStart = authMe.indexOf('if (refreshFailure === "upstream_error")');
  const upstreamBranchEnd = authMe.indexOf("const response =", upstreamBranchStart);
  assert.ok(upstreamBranchStart >= 0 && upstreamBranchEnd > upstreamBranchStart);
  const upstreamBranch = authMe.slice(upstreamBranchStart, upstreamBranchEnd);
  assert.match(upstreamBranch, /logger\.error/);
  assert.doesNotMatch(upstreamBranch, /err:/);

  assert.match(authMe, /operation: "auth_me", err/);
});
