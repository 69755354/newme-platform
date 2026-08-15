import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAuthSessionCookie } from "../../src/lib/auth-cookie.mjs";

// Behavioural coverage for POST /api/auth/login. This endpoint is deliberately
// pre-authentication, so it is the one route where a mistake is reachable by
// anonymous callers: it must reject foreign origins, bound attempts, refuse to
// issue cookies to an inactive profile, revoke the token it refuses to hand out,
// and never echo or log the submitted credential.

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SUPABASE_URL = "https://auth.test.local";
const ANON_KEY = "test-anon-key";
const COOKIE_NAMES = { authToken: "sb-test-auth-token", refreshToken: "sb-test-refresh-token" };

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const source = fsSync.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

class MockResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers();
    this.cookiesSet = [];
    this.cookies = {
      set: (name, value, options = {}) => {
        this.cookiesSet.push({ name, value, options });
      },
    };
  }
  async json() {
    return this.body;
  }
}

function createNextServerMock() {
  return { NextResponse: { json: (body, init) => new MockResponse(body, init) } };
}

/**
 * Fresh route instance per test. Loading it anew also gives it a fresh
 * rate-limiter, so attempt bounds are isolated between cases.
 */
function loadLoginRoute({ logs = [] } = {}) {
  return loadTypeScriptModule("src/app/api/auth/login/route.ts", {
    "next/server": createNextServerMock(),
    "@/lib/auth-profile.mjs": { isActiveProfile: (p) => p?.is_active === true },
    "@/lib/logger": {
      logger: {
        error: (...args) => logs.push(["error", ...args]),
        warn: (...args) => logs.push(["warn", ...args]),
        info: (...args) => logs.push(["info", ...args]),
      },
    },
    // Real rate limiter and real cookie contract: this suite asserts actual
    // behaviour, not a stub of it.
    "@/lib/rate-limit": loadTypeScriptModule("src/lib/rate-limit.ts", {}),
    "@/lib/session-cookies": loadTypeScriptModule("src/lib/session-cookies.ts", {
      "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => COOKIE_NAMES },
    }),
  });
}

const SECRET_PASSWORD = "correct-horse-battery-staple";

/**
 * Stub the two upstream calls the route makes plus the revoke call, recording
 * what it asked for.
 */
function stubUpstream({ grantStatus = 200, grantBody, profile, profileStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method ?? "GET", body: init.body });
    if (target.includes("/auth/v1/token")) {
      return {
        ok: grantStatus >= 200 && grantStatus < 300,
        status: grantStatus,
        json: async () => grantBody ?? {
          access_token: "issued-access-token",
          refresh_token: "issued-refresh-token",
          expires_in: 3600,
          user: { id: "user-1", email: "owner@example.com" },
        },
        text: async () => "Invalid login credentials: " + SECRET_PASSWORD,
      };
    }
    if (target.includes("/rest/v1/profiles")) {
      return {
        ok: profileStatus >= 200 && profileStatus < 300,
        status: profileStatus,
        json: async () => (profile === undefined
          ? [{ is_active: true, role: "sales", full_name: "Owner", force_password_change: false }]
          : profile),
      };
    }
    if (target.includes("/auth/v1/logout")) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    throw new Error("unexpected upstream call: " + target);
  };
  return calls;
}

function loginRequest(body, headers = {}) {
  return new Request("https://app.newme.ae/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", host: "app.newme.ae", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const CREDENTIALS = { email: "owner@example.com", password: SECRET_PASSWORD };

test.beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
});

const REAL_FETCH = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

test("only same-origin JSON requests are accepted", async () => {
  const route = loadLoginRoute();
  stubUpstream();

  const wrongType = await route.POST(new Request("https://app.newme.ae/api/auth/login", {
    method: "POST",
    headers: { "content-type": "text/plain", host: "app.newme.ae" },
    body: "email=owner@example.com",
  }));
  assert.equal(wrongType.status, 415);
  assert.deepEqual(wrongType.cookiesSet, []);

  const foreignOrigin = await route.POST(
    loginRequest(CREDENTIALS, { origin: "https://evil.example" }),
  );
  assert.equal(foreignOrigin.status, 403);
  assert.deepEqual(await foreignOrigin.json(), { error: "invalid_origin" });
  assert.deepEqual(foreignOrigin.cookiesSet, []);

  const sameOrigin = await route.POST(
    loginRequest(CREDENTIALS, { origin: "https://app.newme.ae" }),
  );
  assert.equal(sameOrigin.status, 200);
});

test("a caller-supplied forwarded host cannot widen the accepted origin", async () => {
  const route = loadLoginRoute();
  stubUpstream();
  const response = await route.POST(loginRequest(CREDENTIALS, {
    origin: "https://attacker.example",
    "x-forwarded-host": "attacker.example",
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(response.cookiesSet, []);
});

test("rejected credentials get one generic answer and no session", async () => {
  const logs = [];
  const route = loadLoginRoute({ logs });
  stubUpstream({ grantStatus: 400 });

  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_credentials" });
  assert.deepEqual(response.cookiesSet, []);

  // The upstream failure text can quote the submitted credential. It must not
  // reach the caller or the logs.
  assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(SECRET_PASSWORD));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET_PASSWORD));
});

test("an inactive profile receives no cookie and its issued token is revoked", async () => {
  const route = loadLoginRoute();
  const calls = stubUpstream({ profile: [{ is_active: false, role: "sales" }] });

  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "inactive_account" });
  assert.deepEqual(response.cookiesSet, []);

  const revoke = calls.find((c) => c.url.includes("/auth/v1/logout"));
  assert.ok(revoke, "the token issued to an inactive profile must be revoked upstream");
  assert.equal(revoke.method, "POST");
});

test("a missing profile row is treated as inactive", async () => {
  const route = loadLoginRoute();
  const calls = stubUpstream({ profile: [] });
  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 403);
  assert.deepEqual(response.cookiesSet, []);
  assert.ok(calls.some((c) => c.url.includes("/auth/v1/logout")));
});

test("the active profile gate runs against the freshly issued token, not a privileged key", async () => {
  const route = loadLoginRoute();
  const calls = stubUpstream();
  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 200);

  const profileCall = calls.find((c) => c.url.includes("/rest/v1/profiles"));
  assert.ok(profileCall, "the profile must be read before a session is issued");
  assert.match(profileCall.url, /id=eq\.user-1/);
  assert.doesNotMatch(profileCall.url, /select=\*/);
});

test("a successful login issues the split-session cookie contract in one response", async () => {
  const route = loadLoginRoute();
  const calls = stubUpstream();
  const response = await route.POST(loginRequest(CREDENTIALS));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0, must-revalidate");
  assert.deepEqual(await response.json(), {
    ok: true,
    userId: "user-1",
    email: "owner@example.com",
    role: "sales",
    isActive: true,
    forcePasswordChange: false,
    fullName: "Owner",
  });

  // One round trip for the browser: the grant and the gate both happened here.
  assert.equal(calls.filter((c) => c.url.includes("/auth/v1/token")).length, 1);
  assert.equal(calls.filter((c) => c.url.includes("/rest/v1/profiles")).length, 1);
  assert.equal(calls.filter((c) => c.url.includes("/auth/v1/logout")).length, 0);

  const auth = response.cookiesSet.find((c) => c.name === COOKIE_NAMES.authToken);
  const refresh = response.cookiesSet.find((c) => c.name === COOKIE_NAMES.refreshToken);
  assert.ok(auth && refresh, "both session cookies must be set");

  // The script-readable half carries the access token only.
  assert.equal(auth.options.httpOnly, false);
  assert.equal(auth.options.secure, true);
  assert.equal(auth.options.sameSite, "strict");
  const parsed = parseAuthSessionCookie(
    `${auth.name}=${encodeURIComponent(auth.value)}`,
    COOKIE_NAMES.authToken,
  );
  assert.equal(parsed?.access_token, "issued-access-token");
  assert.equal(Object.hasOwn(parsed ?? {}, "refresh_token"), false);
  assert.doesNotMatch(auth.value, /issued-refresh-token/);

  // The refresh half is never reachable from page scripts.
  assert.equal(refresh.options.httpOnly, true);
  assert.equal(refresh.options.secure, true);
  assert.equal(refresh.options.sameSite, "strict");
  assert.equal(refresh.value, "issued-refresh-token");
});

test("an incomplete grant response is treated as a failed login", async () => {
  const route = loadLoginRoute();
  stubUpstream({ grantBody: { access_token: "only-access", expires_in: 3600 } });
  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 401);
  assert.deepEqual(response.cookiesSet, []);
});

test("upstream auth failure fails closed as unavailable, not as a session", async () => {
  const route = loadLoginRoute();
  stubUpstream({ grantStatus: 502 });
  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "auth_unavailable" });
  assert.deepEqual(response.cookiesSet, []);
});

test("an unreadable profile fails closed and revokes the issued token", async () => {
  const route = loadLoginRoute();
  const calls = stubUpstream({ profileStatus: 500 });
  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 503);
  assert.deepEqual(response.cookiesSet, []);
  assert.ok(calls.some((c) => c.url.includes("/auth/v1/logout")));
});

test("malformed and empty submissions are rejected before any upstream call", async () => {
  const route = loadLoginRoute();
  const calls = stubUpstream();

  assert.equal((await route.POST(loginRequest("not json"))).status, 400);
  assert.equal((await route.POST(loginRequest({ email: "a@b.c" }))).status, 400);
  assert.equal((await route.POST(loginRequest({ password: "x" }))).status, 400);
  assert.equal((await route.POST(loginRequest({ email: "   ", password: "x" }))).status, 400);
  assert.deepEqual(calls, [], "no credential may be forwarded upstream for an invalid request");
});

// Moving the password grant server side puts every user behind one origin
// address, which collapses the upstream per-IP brute-force bound into a single
// bucket. These cases pin the replacement bound.

test("repeated attempts against one account are bounded", async () => {
  const route = loadLoginRoute();
  stubUpstream({ grantStatus: 400 });
  const attempt = () => route.POST(loginRequest(CREDENTIALS, { "cf-connecting-ip": "203.0.113.9" }));

  for (let i = 0; i < 8; i += 1) {
    assert.equal((await attempt()).status, 401, `attempt ${i + 1} should still be evaluated`);
  }
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "rate_limited" });
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0, "429 must carry Retry-After");
  assert.deepEqual(blocked.cookiesSet, []);
});

test("the account bound is not escaped by changing the address capitalisation", async () => {
  const route = loadLoginRoute();
  stubUpstream({ grantStatus: 400 });
  const attempt = (email) => route.POST(loginRequest(
    { email, password: "guess" },
    { "cf-connecting-ip": "203.0.113.10" },
  ));

  for (let i = 0; i < 8; i += 1) {
    const email = i % 2 === 0 ? "Owner@Example.com" : "owner@example.com";
    assert.equal((await attempt(email)).status, 401);
  }
  assert.equal((await attempt("OWNER@EXAMPLE.COM")).status, 429);
});

test("a single source address is bounded across many accounts", async () => {
  const route = loadLoginRoute();
  stubUpstream({ grantStatus: 400 });
  const attempt = (n) => route.POST(loginRequest(
    { email: `user${n}@example.com`, password: "guess" },
    { "cf-connecting-ip": "198.51.100.7" },
  ));

  for (let i = 0; i < 20; i += 1) {
    assert.equal((await attempt(i)).status, 401, `attempt ${i + 1} should still be evaluated`);
  }
  assert.equal((await attempt(9999)).status, 429);
});

test("one exhausted source address does not lock out another", async () => {
  const route = loadLoginRoute();
  stubUpstream({ grantStatus: 400 });
  const attempt = (ip, n) => route.POST(loginRequest(
    { email: `user${n}@example.com`, password: "guess" },
    { "cf-connecting-ip": ip },
  ));

  for (let i = 0; i < 21; i += 1) await attempt("198.51.100.8", i);
  assert.equal((await attempt("198.51.100.8", 100)).status, 429);
  assert.equal((await attempt("198.51.100.9", 200)).status, 401);
});

test("an exhausted source cannot consume an account bucket", async () => {
  const route = loadLoginRoute();
  stubUpstream({ grantStatus: 400 });
  const request = (ip, email) => route.POST(loginRequest(
    { email, password: "guess" },
    { "cf-connecting-ip": ip },
  ));

  for (let i = 0; i < 20; i += 1) {
    assert.equal(
      (await request("198.51.100.70", `source-fill-${i}@example.com`)).status,
      401,
    );
  }
  for (let i = 0; i < 9; i += 1) {
    assert.equal(
      (await request("198.51.100.70", "untouched-account@example.com")).status,
      429,
    );
  }
  assert.equal(
    (await request("198.51.100.71", "untouched-account@example.com")).status,
    401,
    "IP refusal must short-circuit before the account namespace is consumed",
  );
});

test("a rate-limited attempt is never forwarded upstream", async () => {
  const route = loadLoginRoute();
  const calls = stubUpstream({ grantStatus: 400 });
  const attempt = () => route.POST(loginRequest(CREDENTIALS, { "cf-connecting-ip": "203.0.113.11" }));

  for (let i = 0; i < 8; i += 1) await attempt();
  const upstreamBefore = calls.length;
  assert.equal((await attempt()).status, 429);
  assert.equal(calls.length, upstreamBefore, "a bounded attempt must not reach the auth provider");
});

test("missing auth configuration fails closed instead of issuing a session", async () => {
  const route = loadLoginRoute();
  stubUpstream();
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const response = await route.POST(loginRequest(CREDENTIALS));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "auth_unavailable" });
  assert.deepEqual(response.cookiesSet, []);
});
