/**
 * auth/me route handler unit tests.
 *
 * Run:
 *   node --experimental-test-module-mocks \
 *        --loader ./scripts/test-alias-loader.mjs \
 *        --test tests/unit/auth-me.test.mjs
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Mock state (module-level so tests can configure per-case) ──
const mockGetUser = mock.fn();
const mockProfileSingle = mock.fn();
const mockLoggerError = mock.fn();
const mockCookieSet = mock.fn();
let mockRefreshedCookies = [];
let mockRefreshAttempted = false;

// ── Mock NextResponse ──
const mockNextResponse = {
  json: (body, init) => ({
    status: init?.status || 200,
    body,
    cookies: { set: mockCookieSet },
    headers: new Map(),
  }),
};

// ── Module mocks (specifiers must be resolvable) ──
mock.module("@/lib/supabase-server", {
  namedExports: {
    createServerSupabase: mock.fn(async () => ({
      auth: { getUser: mockGetUser },
    })),
    getRefreshedCookies: () => mockRefreshedCookies,
    getRefreshAttempted: () => mockRefreshAttempted,
  },
});

mock.module("@/lib/logger", {
  namedExports: {
    logger: { error: mockLoggerError, info: mock.fn(), warn: mock.fn() },
  },
});

mock.module("next/server", {
  namedExports: { NextResponse: mockNextResponse },
});

mock.module("@supabase/supabase-js", {
  namedExports: {
    createClient: mock.fn(() => ({
      from: mock.fn(() => ({
        select: mock.fn(() => ({
          eq: mock.fn(() => ({
            single: mockProfileSingle,
          })),
        })),
      })),
    })),
  },
});

// ── Import route AFTER mocks ──
const { GET } = await import("../../src/app/api/auth/me/route.js");

// ── Helpers ──
function makeRequest(headers = {}) {
  return new Request("http://localhost:3001/api/auth/me", { headers });
}

const VALID_USER = { id: "user-1", email: "test@newme.ae" };
const VALID_PROFILE = {
  role: "admin",
  is_active: true,
  force_password_change: false,
  full_name: "Test User",
};

// ── Tests ──
describe("auth/me", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    mockGetUser.mock.resetCalls();
    mockProfileSingle.mock.resetCalls();
    mockLoggerError.mock.resetCalls();
    mockCookieSet.mock.resetCalls();
    mockRefreshedCookies = [];
    mockRefreshAttempted = false;
  });

  it("no token → 401", async () => {
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: null },
      error: null,
    }));
    const res = await GET(makeRequest());
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthorized");
  });

  it("invalid bearer → 401", async () => {
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: null },
      error: new Error("invalid token"),
    }));
    const res = await GET(makeRequest({ authorization: "Bearer bad-token" }));
    assert.equal(res.status, 401);
  });

  it("valid bearer → 200", async () => {
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: VALID_USER },
      error: null,
    }));
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: VALID_PROFILE,
      error: null,
    }));
    const res = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, "user-1");
    assert.equal(res.body.email, "test@newme.ae");
    assert.equal(res.body.isActive, true);
    assert.equal(res.body.role, "admin");
  });

  it("valid session cookie → 200", async () => {
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: VALID_USER },
      error: null,
    }));
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: VALID_PROFILE,
      error: null,
    }));
    const res = await GET(makeRequest({ cookie: "sb-access-token=tok" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, "user-1");
  });

  it("expired session → refresh → 200 + Set-Cookie", async () => {
    mockRefreshedCookies = [
      { name: "sb-auth-token", value: "new-tok", options: { path: "/" } },
      { name: "sb-refresh-token", value: "new-ref", options: { path: "/" } },
    ];
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: VALID_USER },
      error: null,
    }));
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: VALID_PROFILE,
      error: null,
    }));
    const res = await GET(makeRequest({ cookie: "sb-access-token=expired" }));
    assert.equal(res.status, 200);
    assert.equal(mockCookieSet.mock.calls.length, 2);
    assert.equal(mockCookieSet.mock.calls[0].arguments[0], "sb-auth-token");
    assert.equal(mockCookieSet.mock.calls[1].arguments[0], "sb-refresh-token");
  });

  it("refresh failure → 401 Token refresh failed", async () => {
    mockRefreshAttempted = true;
    mockRefreshedCookies = [];
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: null },
      error: null,
    }));
    const res = await GET(makeRequest({ cookie: "sb-access-token=expired" }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, "Token refresh failed");
  });

  it("no refresh attempted → 401 unauthorized (not Token refresh failed)", async () => {
    mockRefreshAttempted = false;
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: null },
      error: null,
    }));
    const res = await GET(makeRequest({ cookie: "sb-access-token=tok" }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthorized");
  });

  it("inactive user → 401 inactive_account", async () => {
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: VALID_USER },
      error: null,
    }));
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: { ...VALID_PROFILE, is_active: false },
      error: null,
    }));
    const res = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "inactive_account");
  });

  it("missing env → 500", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: VALID_USER },
      error: null,
    }));
    const res = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "internal_error");
  });

  it("profile lookup failure → 500", async () => {
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: VALID_USER },
      error: null,
    }));
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: null,
      error: { code: "PGRST116", message: "not found" },
    }));
    const res = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "internal_error");
  });

  it("unexpected exception → 500 + Pino error", async () => {
    mockGetUser.mock.mockImplementation(async () => {
      throw new Error("unexpected crash");
    });
    const res = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "internal_error");
    assert.equal(mockLoggerError.mock.calls.length, 1);
    const logArgs = mockLoggerError.mock.calls[0].arguments[0];
    assert.equal(logArgs.operation, "auth_me");
    assert.ok(logArgs.request_id);
  });

  it("no _dbg_key in any response", async () => {
    mockGetUser.mock.mockImplementation(async () => ({
      data: { user: null },
      error: null,
    }));
    const res = await GET(makeRequest());
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes("_dbg_key"), "response must not contain _dbg_key");
  });

  it("log does not contain token/cookie/key values", async () => {
    mockGetUser.mock.mockImplementation(async () => {
      throw new Error("crash");
    });
    await GET(makeRequest({
      authorization: "Bearer secret-token-123",
      cookie: "sb-access-token=secret-cookie",
    }));
    if (mockLoggerError.mock.calls.length > 0) {
      const logStr = JSON.stringify(mockLoggerError.mock.calls[0].arguments[0]);
      assert.ok(!logStr.includes("secret-token-123"), "log must not contain bearer token");
      assert.ok(!logStr.includes("secret-cookie"), "log must not contain cookie value");
      assert.ok(!logStr.includes("service_role"), "log must not contain service key");
    }
  });
});
