/**
 * Request-auth context regression tests.
 *
 * Run through the repository alias loader:
 * node --experimental-test-module-mocks --loader ./scripts/test-alias-loader.mjs \
 *   --test tests/unit/request-auth-context.test.mjs
 */
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mockCreateServerSupabase = mock.fn();
const mockGetUser = mock.fn();
const mockProfileSingle = mock.fn();
const mockCookieSet = mock.fn();
let refreshedCookies = [];
let refreshAttempted = false;
let refreshFailure;

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mock.fn(() => ({
    select: mock.fn(() => ({
      eq: mock.fn(() => ({ single: mockProfileSingle })),
    })),
  })),
};

mock.module("@/lib/supabase-server", {
  namedExports: {
    createServerSupabase: mockCreateServerSupabase,
    getRefreshedCookies: () => refreshedCookies,
    getRefreshAttempted: () => refreshAttempted,
    getRefreshFailure: () => refreshFailure,
  },
});
const {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} = await import("../../src/lib/request-auth-context.js");

const USER = { id: "user-1", email: "admin@staging.example" };
const PROFILE = {
  id: "user-1",
  email: "admin@staging.example",
  full_name: "Staging Admin",
  role: "admin",
  is_active: true,
};

function request(headers = {}) {
  return new Request("https://staging.newme.ae/api/admin/impersonate", { headers });
}

describe("request-auth context", () => {
  beforeEach(() => {
    mockCreateServerSupabase.mock.resetCalls();
    mockGetUser.mock.resetCalls();
    mockProfileSingle.mock.resetCalls();
    mockCookieSet.mock.resetCalls();
    mockCreateServerSupabase.mock.mockImplementation(async () => mockSupabase);
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: USER }, error: null }));
    mockProfileSingle.mock.mockImplementation(async () => ({ data: PROFILE, error: null }));
    refreshedCookies = [];
    refreshAttempted = false;
    refreshFailure = undefined;
  });

  it("uses the explicit bearer and cookie request boundary exactly once", async () => {
    const context = await getRequestAuthContext(request({
      authorization: "Bearer bearer-token",
      cookie: "sb-staging-auth-token=cookie-token",
    }));

    assert.equal(context.user.id, USER.id);
    assert.equal(context.role, "admin");
    assert.equal(mockCreateServerSupabase.mock.calls.length, 1);
    assert.deepEqual(mockCreateServerSupabase.mock.calls[0].arguments, [
      "bearer-token",
      "sb-staging-auth-token=cookie-token",
    ]);
  });

  it("uses an explicit cookie header when no bearer is present", async () => {
    await getRequestAuthContext(request({ cookie: "sb-staging-auth-token=cookie-token" }));

    assert.deepEqual(mockCreateServerSupabase.mock.calls[0].arguments, [
      undefined,
      "sb-staging-auth-token=cookie-token",
    ]);
  });

  it("returns typed unauthorized for an invalid or missing session", async () => {
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: null }, error: null }));

    await assert.rejects(
      () => getRequestAuthContext(request()),
      (error) => error instanceof RequestAuthError
        && error.code === "unauthorized"
        && error.status === 401,
    );
  });

  it("returns typed inactive_account for an inactive profile", async () => {
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: { ...PROFILE, is_active: false },
      error: null,
    }));

    await assert.rejects(
      () => getRequestAuthContext(request()),
      (error) => error instanceof RequestAuthError
        && error.code === "inactive_account"
        && error.status === 401,
    );
  });

  it("returns typed 503 for profile infrastructure failures", async () => {
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: null,
      error: { code: "XX000", message: "database unavailable" },
    }));

    await assert.rejects(
      () => getRequestAuthContext(request()),
      (error) => error instanceof RequestAuthError
        && error.code === "profile_unavailable"
        && error.status === 503,
    );
  });

  it("propagates refreshed cookies to a representative response", async () => {
    refreshedCookies = [
      { name: "sb-auth-token", value: "new-access", options: { path: "/" } },
      { name: "sb-refresh-token", value: "new-refresh", options: { path: "/", httpOnly: true } },
    ];
    const context = await getRequestAuthContext(request());
    const response = { cookies: { set: mockCookieSet } };

    applyRequestAuthCookies(context, response);

    assert.equal(mockCookieSet.mock.calls.length, 2);
    assert.equal(mockCookieSet.mock.calls[0].arguments[0], "sb-auth-token");
    assert.equal(mockCookieSet.mock.calls[1].arguments[0], "sb-refresh-token");
  });

  it("keeps the high-risk impersonation route on one context boundary", () => {
    const source = readFileSync("src/app/api/admin/impersonate/route.ts", "utf8");
    assert.match(source, /getRequestAuthContext\(request\)/);
    assert.doesNotMatch(source, /createServerSupabase/);
    assert.equal((source.match(/getRequestAuthContext\(/g) ?? []).length, 1);
  });
});
