// S6 · review 4d #17 / 4b #14: the lockout message did not say how long to
// wait, and successful sign-ins consumed the failed-attempt budget (a user
// who signed in 4 times was locked out by their 5th failure, not the 8th).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function loadTs(relativePath, mocks = {}) {
  const ts = require("typescript");
  const filename = path.join(ROOT, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previous = Module._load;
  Module._load = function mocked(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return previous.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previous;
  }
}

class MockResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers();
    this.cookies = { set() {} };
  }
  async json() { return this.body; }
}

function loadLoginRoute() {
  return loadTs("src/app/api/auth/login/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => new MockResponse(body, init) } },
    "@/lib/auth-profile.mjs": { isActiveProfile: (p) => p?.is_active === true },
    "@/lib/logger": { logger: { error() {}, warn() {}, info() {} } },
    "@/lib/audit-log": { AUDIT_ACTIONS: {}, accountKey: () => null, writeAuditLog: async () => {} },
    "@/lib/rate-limit": loadTs("src/lib/rate-limit.ts"),
    "@/lib/session-cookies": loadTs("src/lib/session-cookies.ts", {
      "@/lib/supabase-cookie-names": {
        getSupabaseCookieNames: () => ({ authToken: "sb-a", refreshToken: "sb-r" }),
      },
    }),
  });
}

const GOOD = "right-password";
function stubUpstream() {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/auth/v1/token")) {
      const { password } = JSON.parse(init.body);
      const ok = password === GOOD;
      return {
        ok, status: ok ? 200 : 400,
        json: async () => ({
          access_token: "a", refresh_token: "r", expires_in: 3600,
          user: { id: "user-1", email: "owner@example.com" },
        }),
      };
    }
    if (target.includes("/rest/v1/profiles")) {
      return { ok: true, status: 200, json: async () => [{ is_active: true, role: "sales" }] };
    }
    return { ok: true, status: 204, json: async () => ({}) };
  };
}

const REAL_FETCH = globalThis.fetch;
test.beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth.test.local";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});
test.afterEach(() => { globalThis.fetch = REAL_FETCH; });

const attempt = (route, password, ip = "203.0.113.50") => route.POST(new Request("https://app.newme.ae/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", host: "app.newme.ae", "cf-connecting-ip": ip },
  body: JSON.stringify({ email: "owner@example.com", password }),
}));

test("successful sign-ins do not count toward the failed-attempt lockout", async () => {
  const route = loadLoginRoute();
  stubUpstream();
  for (let i = 0; i < 6; i += 1) {
    assert.equal((await attempt(route, GOOD)).status, 200, `success ${i + 1}`);
  }
  // The documented budget is 8 failures per 15 minutes per account.
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await attempt(route, "wrong")).status, 401, `failure ${i + 1} must still be evaluated`);
  }
  const locked = await attempt(route, "wrong");
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("Retry-After")) > 0);
});

test("successful sign-ins from one office address do not exhaust the shared address budget", async () => {
  const route = loadLoginRoute();
  stubUpstream();
  for (let i = 0; i < 25; i += 1) {
    assert.equal((await attempt(route, GOOD, "198.51.100.200")).status, 200, `success ${i + 1}`);
  }
});

test("the refund only undoes this request's own counter, never more", () => {
  const { consumeRateLimit } = loadTs("src/lib/rate-limit.ts");
  const opts = { limit: 3, windowMs: 60_000, namespace: "refund-probe" };
  const now = 1_000_000;
  const first = consumeRateLimit("k", opts, now);
  first.release?.();
  first.release?.(); // double release must be a no-op
  assert.equal(consumeRateLimit("k", opts, now).remaining, 2);
  assert.equal(consumeRateLimit("k", opts, now).remaining, 1);
  assert.equal(consumeRateLimit("k", opts, now).remaining, 0);
  assert.equal(consumeRateLimit("k", opts, now).allowed, false);
});

test("the lockout message states the wait in minutes, from Retry-After", async () => {
  const { lockoutWaitMinutes } = await import("../../src/lib/login-lockout.mjs");
  assert.equal(lockoutWaitMinutes("900"), 15);
  assert.equal(lockoutWaitMinutes("61"), 2);
  assert.equal(lockoutWaitMinutes("5"), 1);
  assert.equal(lockoutWaitMinutes(null), null);
  assert.equal(lockoutWaitMinutes("garbage"), null);

  const page = read("src/app/login/page.tsx");
  assert.match(page, /Retry-After/);
  assert.match(page, /t\(lockoutMessageKey\(scope\)\)/);
  const dict = read("src/lib/i18n/translations.ts");
  const zh = dict.slice(dict.indexOf("  zh: {"));
  assert.match(zh, /rateLimitedWait: ".*\{n\}.*分钟/);
});

test("the per-address limit is not reported as an account lockout", async () => {
  const { lockoutMessageKey } = await import("../../src/lib/login-lockout.mjs");
  assert.equal(lockoutMessageKey("account"), "login.rateLimitedWait");
  assert.equal(lockoutMessageKey("address"), "login.rateLimitedNetworkWait");
  const route = read("src/app/api/auth/login/route.ts");
  assert.match(route, /ipLimit\.retryAfterSeconds\)\);\n[^\n]*\n\s*response\.headers\.set\("X-RateLimit-Scope", "address"\)/);
  assert.match(route, /accountLimit\.retryAfterSeconds\)\);\n[^\n]*\n\s*response\.headers\.set\("X-RateLimit-Scope", "account"\)/);
  const page = read("src/app/login/page.tsx");
  assert.match(page, /X-RateLimit-Scope/);
  const dict = read("src/lib/i18n/translations.ts");
  const zh = dict.slice(dict.indexOf("  zh: {"));
  assert.match(zh, /rateLimitedNetworkWait: ".*\{n\}.*分钟/);
  assert.doesNotMatch(zh.match(/rateLimitedNetworkWait: "([^"]*)"/)[1], /输错 8 次/);
});

test("the sign-in page offers a language switch", () => {
  const page = read("src/app/login/page.tsx");
  assert.match(page, /<LanguageToggle/);
  assert.doesNotMatch(page, />Loading\.\.\.</, "suspense fallback must not be hard-coded English");
});
