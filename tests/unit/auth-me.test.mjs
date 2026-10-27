/**
 * Executable unit tests for GET /api/auth/me.
 *
 * The route is transpiled in memory so the repository's TypeScript source is
 * exercised while all network-bearing dependencies remain local mocks.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const mockGetUser = mock.fn();
const mockProfileSingle = mock.fn();
const mockLoggerError = mock.fn();
const mockCookieSet = mock.fn();
const mockCreateServerSupabase = mock.fn();
let refreshedCookies = [];
let refreshAttempted = false;
let refreshFailure;

const client = {
  auth: { getUser: mockGetUser },
  from: mock.fn(() => ({
    select: mock.fn(() => ({
      eq: mock.fn(() => ({ single: mockProfileSingle })),
    })),
  })),
};

const NextResponse = {
  json(body, init = {}) {
    return {
      status: init.status ?? 200,
      body,
      headers: new Headers(),
      cookies: { set: mockCookieSet },
      async json() { return body; },
    };
  },
};

const { GET } = loadTypeScriptModule("src/app/api/auth/me/route.ts", {
  "@/lib/supabase-server": {
    createServerSupabase: mockCreateServerSupabase,
    getRefreshedCookies: () => refreshedCookies,
    getRefreshAttempted: () => refreshAttempted,
    getRefreshFailure: () => refreshFailure,
  },
  "@/lib/supabase-cookie-names": {
    getSupabaseCookieNames: () => ({
      authToken: "sb-project-auth-token",
      refreshToken: "sb-project-refresh-token",
    }),
  },
  "@/lib/logger": {
    logger: { error: mockLoggerError, info: mock.fn(), warn: mock.fn() },
  },
  "next/server": { NextResponse },
});

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

describe("auth/me", () => {
  beforeEach(() => {
    mockGetUser.mock.resetCalls();
    mockProfileSingle.mock.resetCalls();
    mockLoggerError.mock.resetCalls();
    mockCookieSet.mock.resetCalls();
    mockCreateServerSupabase.mock.resetCalls();
    mockCreateServerSupabase.mock.mockImplementation(async () => client);
    refreshedCookies = [];
    refreshAttempted = false;
    refreshFailure = undefined;
  });

  it("returns 401 when no authenticated user exists", async () => {
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: null }, error: null }));
    const response = await GET(makeRequest());
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "unauthorized");
  });

  it("passes a bearer token to getUser and returns the caller profile", async () => {
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: VALID_USER }, error: null }));
    mockProfileSingle.mock.mockImplementation(async () => ({ data: VALID_PROFILE, error: null }));
    const response = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(response.status, 200);
    assert.equal(mockGetUser.mock.calls[0].arguments[0], "valid-token");
    assert.equal(response.body.userId, VALID_USER.id);
    assert.equal(response.body.role, "admin");
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0, must-revalidate");
    assert.equal(response.headers.get("vary"), "Cookie, Authorization");
  });

  it("uses cookie authentication without inventing a bearer argument", async () => {
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: VALID_USER }, error: null }));
    mockProfileSingle.mock.mockImplementation(async () => ({ data: VALID_PROFILE, error: null }));
    const response = await GET(makeRequest({ cookie: "sb-access-token=token" }));
    assert.equal(response.status, 200);
    assert.equal(mockGetUser.mock.calls[0].arguments.length, 0);
  });

  it("applies every refreshed cookie to a successful response", async () => {
    refreshedCookies = [
      { name: "sb-project-auth-token", value: "new-token", options: { path: "/" } },
      { name: "sb-project-refresh-token", value: "new-refresh", options: { path: "/" } },
    ];
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: VALID_USER }, error: null }));
    mockProfileSingle.mock.mockImplementation(async () => ({ data: VALID_PROFILE, error: null }));
    const response = await GET(makeRequest({ cookie: "sb-access-token=expired" }));
    assert.equal(response.status, 200);
    assert.deepEqual(
      mockCookieSet.mock.calls.map((call) => call.arguments[0]),
      ["sb-project-auth-token", "sb-project-refresh-token"],
    );
  });

  it("classifies an attempted refresh without cookies as token refresh failure", async () => {
    refreshAttempted = true;
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: null }, error: null }));
    const response = await GET(makeRequest({ cookie: "sb-access-token=expired" }));
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "UNAUTHORIZED");
    assert.equal(response.body.error.message, "Token refresh failed");
  });

  it("clears dynamic and legacy cookies after an invalid refresh token", async () => {
    refreshFailure = "invalid_refresh_token";
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: null }, error: null }));
    const response = await GET(makeRequest({ cookie: "sb-refresh-token=invalid" }));
    assert.equal(response.status, 401);
    assert.deepEqual(
      mockCookieSet.mock.calls.map((call) => call.arguments[0]),
      ["sb-project-auth-token", "sb-project-refresh-token", "sb-access-token", "sb-refresh-token"],
    );
    assert.ok(mockCookieSet.mock.calls.every((call) => call.arguments[2].maxAge === 0));
  });

  it("returns 503 and logs a classified upstream refresh failure", async () => {
    refreshFailure = "upstream_error";
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: null }, error: null }));
    const response = await GET(makeRequest());
    assert.equal(response.status, 503);
    assert.equal(response.body.error, "auth_unavailable");
    assert.equal(mockLoggerError.mock.calls[0].arguments[0].operation, "auth_refresh");
  });

  it("rejects inactive profiles", async () => {
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: VALID_USER }, error: null }));
    mockProfileSingle.mock.mockImplementation(async () => ({
      data: { ...VALID_PROFILE, is_active: false },
      error: null,
    }));
    const response = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "inactive_account");
  });

  it("returns 500 when the caller profile lookup fails", async () => {
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: VALID_USER }, error: null }));
    mockProfileSingle.mock.mockImplementation(async () => ({ data: null, error: { code: "PGRST116" } }));
    const response = await GET(makeRequest({ authorization: "Bearer valid-token" }));
    assert.equal(response.status, 500);
    assert.equal(response.body.error, "internal_error");
  });

  it("contains unexpected exceptions and logs only structured metadata", async () => {
    mockGetUser.mock.mockImplementation(async () => { throw new Error("unexpected crash"); });
    const response = await GET(makeRequest({
      authorization: "Bearer secret-token-123",
      cookie: "sb-access-token=secret-cookie",
    }));
    assert.equal(response.status, 500);
    assert.equal(response.body.error, "internal_error");
    const logged = JSON.stringify(mockLoggerError.mock.calls[0].arguments[0]);
    assert.match(logged, /"operation":"auth_me"/);
    assert.doesNotMatch(logged, /secret-token-123|secret-cookie|test-service-key/);
  });

  it("contains createServerSupabase failures", async () => {
    mockCreateServerSupabase.mock.mockImplementation(async () => { throw new Error("configuration failed"); });
    const response = await GET(makeRequest());
    assert.equal(response.status, 500);
    assert.equal(response.body.error, "internal_error");
  });

  it("never includes the retired debug key in an unauthorized response", async () => {
    mockGetUser.mock.mockImplementation(async () => ({ data: { user: null }, error: null }));
    const response = await GET(makeRequest());
    assert.doesNotMatch(JSON.stringify(response.body), /_dbg_key/);
  });
});
