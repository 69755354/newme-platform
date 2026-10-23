import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setImmediate as flush } from "node:timers/promises";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { NextResponse } = require("next/server");

function load(relative, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { loaded._compile(output, filename); return loaded.exports; }
  finally { Module._load = original; }
}

const names = { authToken: "sb-fixture-auth-token", refreshToken: "sb-fixture-refresh-token" };
const cookies = [{ name: names.refreshToken, value: "rotated-refresh", options: { path: "/", httpOnly: true, maxAge: 3600 } }];
const user = { id: "fixture", email: "fixture@example.test" };
const profile = { id: user.id, role: "sales", is_active: true, force_password_change: false };
const pending = () => new Promise(() => {});
const request = () => new Request("https://example.test/api", { headers: { cookie: `${names.refreshToken}=refresh` } });

function authModules(stage, delay = {}, onComplete = () => {}) {
  const calls = [];
  async function run(name, value) {
    calls.push(name);
    if (name === stage) return pending();
    if (delay[name]) await new Promise(resolve => setTimeout(resolve, delay[name]));
    onComplete(name);
    return value;
  }
  const client = {
    auth: { getUser: () => run("getUser", { data: { user }, error: null }) },
    rpc: () => run("boundary", { data: "ok", error: null }),
    from: () => ({ select: () => ({ eq: () => ({ single: () => run("profile", { data: profile, error: null }) }) }) }),
  };
  const server = {
    createServerSupabase: () => run("create", client),
    getRefreshedCookies: () => cookies,
    getRefreshAttempted: () => true,
    getRefreshFailure: () => undefined,
  };
  const mocks = {
    "next/server": { NextResponse },
    "@/lib/supabase-server": server,
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "@/lib/forced-password-change.mjs": { FORCED_SESSION_ERROR: "password_change_required", isForcedPasswordChange: () => false },
    "@/lib/logger": { logger: { error() {} } },
  };
  return {
    context: load("src/lib/request-auth-context.ts", mocks),
    me: load("src/app/api/auth/me/route.ts", mocks),
    calls,
  };
}

for (const stage of ["create", "getUser", "boundary", "profile"]) {
  test(`request auth bounds stalled ${stage} inside one 3-second budget`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const { context } = authModules(stage);
    let settled = false;
    const result = context.getRequestAuthContext(request()).then(
      value => ({ value }), error => ({ error }),
    ).finally(() => { settled = true; });
    await flush();
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    const { error } = await result;
    assert.equal(error.status, 503);
    assert.equal(error.code, ["boundary", "profile"].includes(stage) ? "profile_unavailable" : "auth_unavailable");
    assert.equal(error.clearSession, false);
    assert.deepEqual(error.refreshedCookies, stage === "create" ? [] : cookies);
  });
}

for (const stage of ["create", "getUser", "profile"]) {
  test(`auth/me returns retryable 503 for stalled ${stage}, preserving session cookies`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const { me } = authModules(stage);
    let settled = false;
    const responsePromise = me.GET(request()).finally(() => { settled = true; });
    await flush();
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    const response = await responsePromise;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "auth_unavailable" });
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(response.headers.get("vary"), "Cookie, Authorization");
    const wire = response.headers.get("set-cookie") ?? "";
    assert.doesNotMatch(wire, /Max-Age=0/);
    if (stage !== "create") assert.match(wire, /rotated-refresh/);
  });
}

for (const entry of ["context", "me"]) {
  test(`${entry} shares the deadline across successful stages before a slow profile lookup`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const modules = authModules(null, { create: 1500, getUser: 1000, profile: 1000 });
    const result = entry === "context"
      ? modules.context.getRequestAuthContext(request()).then(value => ({ value }), error => ({ error }))
      : modules.me.GET(request());
    await flush();
    t.mock.timers.tick(1500);
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.ok(modules.calls.includes("profile"));
    t.mock.timers.tick(500);
    const resolved = await result;
    assert.equal(entry === "context" ? resolved.error.status : resolved.status, 503);
  });
}

for (const entry of ["context", "me"]) {
  for (const lastStage of entry === "context" ? ["create", "getUser", "boundary"] : ["create", "getUser"]) {
    test(`${entry} does not start another operation when ${lastStage} completes at the deadline`, async (t) => {
      const started = Date.now();
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: started });
      let reachedDeadline = false;
      const modules = authModules(null, {}, (name) => {
        if (reachedDeadline) throw new Error("an expired-budget operation must not be started");
        if (name === lastStage) {
          reachedDeadline = true;
          // Simulate a completion at the deadline before the timer callback runs.
          t.mock.timers.setTime(started + 3000);
        }
      });
      if (entry === "context") {
        await assert.rejects(modules.context.getRequestAuthContext(request()), error => error.status === 503 && !error.clearSession);
      } else {
        const response = await modules.me.GET(request());
        assert.equal(response.status, 503);
        assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
      }
      await flush();
      assert.equal(modules.calls.at(-1), lastStage, "no rejected or pending operation may be created after budget exhaustion");
    });
  }
}

for (const stalledStage of ["headers", "body"]) {
  test(`real refresh fetch aborts stalled ${stalledStage}, releases its shared lock, and can retry`, { timeout: 10000 }, async (t) => {
    let calls = 0;
    let healthy = false;
    const server = http.createServer((_req, res) => {
      calls++;
      if (healthy) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }));
      } else if (stalledStage === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"access_token":');
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon";
    t.after(() => {
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
    });
    const auth = load("src/lib/supabase-server.ts", {
      "@supabase/supabase-js": { createClient: () => ({}) },
      "next/headers": { cookies: () => { throw new Error("explicit cookie header required"); } },
      "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
      "@/lib/auth-refresh.mjs": { classifyRefreshFailure: () => "upstream_error" },
    });
    const cookie = `${names.refreshToken}=fixture-refresh`;
    const started = performance.now();
    const clients = await Promise.all([
      auth.createServerSupabase(undefined, cookie),
      auth.createServerSupabase(undefined, cookie),
    ]);
    assert.equal(calls, 1, "concurrent callers must share one refresh");
    assert.ok(performance.now() - started < 5000, "refresh must settle within its timeout budget");
    for (const client of clients) {
      assert.equal(auth.getRefreshFailure(client), "upstream_error");
      assert.deepEqual(auth.getRefreshedCookies(client), []);
    }
    healthy = true;
    const retried = await auth.createServerSupabase(undefined, cookie);
    assert.equal(calls, 2, "timed-out refresh must release the lock for a subsequent retry");
    assert.equal(auth.getRefreshFailure(retried), undefined);
    assert.equal(auth.getRefreshedCookies(retried).find(c => c.name === names.refreshToken).value, "fresh-refresh");
  });
}
