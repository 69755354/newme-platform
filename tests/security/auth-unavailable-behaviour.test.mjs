// OS fix S1 (review follow-up F-1 .. F-7): behavioural tests for "an auth
// dependency that is slow or down must never look like 'signed out'".
//
// @supabase/auth-js reports an unreachable auth service or an upstream 5xx as
// an error *result* ({ data: { user: null }, error: AuthRetryableFetchError }),
// not an exception. Every path that read `if (error || !user) → /login` sent a
// valid user to the login page during a brief outage. The modules under test
// are transpiled from the repository's TypeScript so the real code runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { NextResponse } = require("next/server");
const skewModule = await import("../../src/lib/deployment-skew.mjs");

function load(relative, mocks = {}, cache = new Map()) {
  const ts = require("typescript");
  const filename = path.join(ROOT, relative);
  if (cache.has(filename)) return cache.get(filename);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    if (request.startsWith("@/")) {
      const target = path.join("src", request.slice(2));
      if (fs.existsSync(path.join(ROOT, `${target}.ts`))) return load(`${target}.ts`, mocks, cache);
      return previousLoad.call(Module, path.join(ROOT, target), parent, isMain);
    }
    return previousLoad.call(Module, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    cache.set(filename, loaded.exports);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

/** The shape auth-js returns for a failed fetch (status 0) or an upstream 5xx. */
function retryableError(status) {
  const error = new Error(status === 0 ? "fetch failed" : `upstream ${status}`);
  error.name = "AuthRetryableFetchError";
  error.status = status;
  return error;
}
/** The shape auth-js returns for an invalid or expired token. */
function sessionError() {
  const error = new Error("invalid JWT");
  error.name = "AuthApiError";
  error.status = 401;
  return error;
}

const user = { id: "user-1", email: "u@example.test" };
const activeProfile = { id: user.id, role: "boss", is_active: true, force_password_change: false };

function withInstantTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => { queueMicrotask(callback); return undefined; };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });
}

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

function loadMe(getUserResult) {
  const client = {
    auth: { getUser: async () => getUserResult },
    rpc: async () => ({ data: "ok", error: null }),
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: activeProfile, error: null }) }) }) }),
  };
  return load("src/app/api/auth/me/route.ts", {
    "next/server": { NextResponse },
    "@/lib/supabase-server": {
      createServerSupabase: async () => client,
      getRefreshedCookies: () => [],
      getRefreshAttempted: () => false,
      getRefreshFailure: () => undefined,
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => ({ authToken: "sb-a", refreshToken: "sb-r" }) },
    "@/lib/forced-password-change.mjs": { FORCED_SESSION_ERROR: "password_change_required", isForcedPasswordChange: () => false },
    "@/lib/logger": { logger: { error() {} } },
  });
}
const meRequest = () => new Request("https://example.test/api/auth/me", { headers: { cookie: "sb-r=refresh" } });

for (const status of [0, 502, 503]) {
  test(`auth/me answers 503 auth_unavailable, not 401, when the auth service fails with status ${status}`, async () => {
    const me = loadMe({ data: { user: null }, error: retryableError(status) });
    const response = await me.GET(meRequest());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "auth_unavailable" });
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /Max-Age=0/, "session cookies must survive an outage");
  });
}

test("auth/me still answers 401 for a definite verdict: invalid token or no user", async () => {
  for (const result of [{ data: { user: null }, error: sessionError() }, { data: { user: null }, error: null }]) {
    const response = await loadMe(result).GET(meRequest());
    assert.equal(response.status, 401);
  }
  const ok = await loadMe({ data: { user }, error: null }).GET(meRequest());
  assert.equal(ok.status, 200);
});

/** What PostgREST returns from `.single()` when RLS hides the caller's own row. */
const NO_PROFILE_ROW = { data: null, error: { code: "PGRST116", details: "The result contains 0 rows", message: "JSON object requested, multiple (or no) rows returned" } };

test("auth/me answers 401 inactive_account, not 500, when the session boundary policy hides the profile row", async () => {
  // A deactivated or banned user cannot read their own profiles row
  // (restrict_profiles_active_session_select), so the lookup is PGRST116 —
  // an error object — rather than an inactive row.
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    rpc: async () => ({ data: "ok", error: null }),
    from: () => ({ select: () => ({ eq: () => ({ single: async () => NO_PROFILE_ROW }) }) }),
  };
  const me = load("src/app/api/auth/me/route.ts", {
    "next/server": { NextResponse },
    "@/lib/supabase-server": { createServerSupabase: async () => client, getRefreshedCookies: () => [], getRefreshAttempted: () => false, getRefreshFailure: () => undefined },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => ({ authToken: "sb-a", refreshToken: "sb-r" }) },
    "@/lib/forced-password-change.mjs": { FORCED_SESSION_ERROR: "password_change_required", isForcedPasswordChange: () => false },
    "@/lib/logger": { logger: { error() {} } },
  });
  const response = await me.GET(meRequest());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "inactive_account" });
});

// ---------------------------------------------------------------------------
// src/proxy.ts
// ---------------------------------------------------------------------------

function nextServer() {
  return {
    NextRequest: class {},
    NextResponse: {
      json: (body, init) => ({ body, status: init?.status ?? 200 }),
      next: () => ({ status: 200 }),
      redirect: (url) => ({ location: String(url), status: 307 }),
    },
  };
}
function proxyRequest(pathname, method) {
  return { headers: new Headers(), method, nextUrl: { pathname }, url: `https://app.newme.ae${pathname}` };
}
function loadProxy(getUserResult, profileResult = { data: activeProfile, error: null }) {
  return load("src/proxy.ts", {
    "next/server": nextServer(),
    "@/lib/supabase-middleware": {
      createMiddlewareClient: async () => ({
        supabase: {
          auth: { getUser: async () => getUserResult },
          from: () => ({ select: () => ({ eq: () => ({ single: async () => profileResult }) }) }),
        },
        getResponse: () => ({ status: 200, served: true }),
      }),
    },
    "@/lib/report-server-error": { reportServerError: async () => {} },
  });
}

for (const status of [0, 503]) {
  test(`proxy treats an auth-service error (status ${status}) as a dependency failure, not as "no session"`, async () => {
    const proxy = loadProxy({ data: { user: null }, error: retryableError(status) });
    for (const pathname of ["/settings", "/team", "/leads/x"]) {
      const page = await proxy.proxy(proxyRequest(pathname, "GET"));
      assert.equal(page.status, 200, `${pathname} renders and re-proves its session`);
      assert.equal(page.location, undefined);
    }
    assert.deepEqual(await proxy.proxy(proxyRequest("/api/leads/a/stage", "POST")), { body: { error: "auth_unavailable" }, status: 503 });
    const action = await proxy.proxy(proxyRequest("/leads/x", "POST"));
    assert.equal(action.status, 307, "a server action posted to a page path fails closed at every stage");
    assert.match(action.location, /\/login\?reason=auth_unavailable$/);
  });
}

test("proxy still sends a definite missing/invalid session on a role-protected page to /login", async () => {
  for (const result of [{ data: { user: null }, error: sessionError() }, { data: { user: null }, error: null }]) {
    const response = await loadProxy(result).proxy(proxyRequest("/settings", "GET"));
    assert.equal(response.status, 307);
    assert.match(response.location, /\/login\?redirect=%2Fsettings$/);
    assert.deepEqual(await loadProxy(result).proxy(proxyRequest("/api/leads/a/stage", "POST")), { body: { error: "unauthorized" }, status: 401 });
  }
});

test("proxy treats a hidden profile row (deactivated account) as inactive, not as an outage", async () => {
  const proxy = loadProxy({ data: { user }, error: null }, NO_PROFILE_ROW);
  const page = await proxy.proxy(proxyRequest("/leads/x", "GET"));
  assert.equal(page.status, 307);
  assert.match(page.location, /\/login\?reason=inactive_account$/);
  assert.deepEqual(await proxy.proxy(proxyRequest("/api/leads", "GET")), { body: { error: "inactive_account" }, status: 401 });
  // A genuine profile outage still soft-fails the page and 503s the API.
  const outage = loadProxy({ data: { user }, error: null }, { data: null, error: { code: "PGRST000", message: "connection refused" } });
  assert.equal((await outage.proxy(proxyRequest("/leads/x", "GET"))).status, 200);
  assert.deepEqual(await outage.proxy(proxyRequest("/api/leads", "GET")), { body: { error: "auth_unavailable" }, status: 503 });
});

// ---------------------------------------------------------------------------
// src/lib/server-page-auth.ts (quotes, projects, settings/ads, cable-costing)
// ---------------------------------------------------------------------------

class Redirect extends Error { constructor(to) { super(`redirect:${to}`); this.to = to; } }

function loadServerPageAuth({ getUser, profile = activeProfile, profileError = null }) {
  const supabase = {
    auth: { getUser },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: profileError }) }) }) }),
  };
  return load("src/lib/server-page-auth.ts", {
    "next/navigation": { redirect: (to) => { throw new Redirect(to); } },
    "@/lib/supabase-server": { createServerSupabase: async () => supabase },
  });
}
const redirectOf = (promise) => promise.then(() => null, (error) => (error instanceof Redirect ? error.to : Promise.reject(error)));

test("a server-rendered page shows connection-failed, not /login, when the auth service errors or stalls", async (t) => {
  for (const status of [0, 503]) {
    const auth = loadServerPageAuth({ getUser: async () => ({ data: { user: null }, error: retryableError(status) }) });
    assert.deepEqual(await auth.authorizeServerPage({ roles: ["admin", "boss", "sales"] }), { status: "unavailable" });
  }
  withInstantTimers(t);
  const stalled = loadServerPageAuth({ getUser: () => new Promise(() => {}) });
  assert.deepEqual(await stalled.authorizeServerPage(), { status: "unavailable" }, "a stalled getUser is bounded by the 3-second budget");
  const profileDown = loadServerPageAuth({ getUser: async () => ({ data: { user }, error: null }), profile: null, profileError: new Error("profiles_500") });
  assert.deepEqual(await profileDown.authorizeServerPage(), { status: "unavailable" });
});

test("a server-rendered page enforces session, is_active, forced password change and role itself", async () => {
  const signedIn = async () => ({ data: { user }, error: null });
  assert.equal(await redirectOf(loadServerPageAuth({ getUser: async () => ({ data: { user: null }, error: null }) }).authorizeServerPage()), "/login");
  assert.equal(await redirectOf(loadServerPageAuth({ getUser: async () => ({ data: { user: null }, error: sessionError() }) }).authorizeServerPage()), "/login");
  assert.equal(
    await redirectOf(loadServerPageAuth({ getUser: signedIn, profile: { ...activeProfile, is_active: false } }).authorizeServerPage()),
    "/login?reason=inactive_account",
  );
  // The real shape for a deactivated/banned account: RLS hides the row, so the
  // lookup is PGRST116 rather than an inactive row.
  assert.equal(
    await redirectOf(loadServerPageAuth({ getUser: signedIn, profile: null, profileError: NO_PROFILE_ROW.error }).authorizeServerPage()),
    "/login?reason=inactive_account",
  );
  // F-2: the proxy may have let the navigation through because its own
  // profile lookup timed out; the page must not render data for a session
  // that is required to change its password.
  assert.equal(
    await redirectOf(loadServerPageAuth({ getUser: signedIn, profile: { ...activeProfile, force_password_change: true } }).authorizeServerPage({ roles: ["boss"] })),
    "/change-password?reason=password_change_required",
  );
  assert.equal(
    await redirectOf(loadServerPageAuth({ getUser: signedIn, profile: { ...activeProfile, role: "sales" } }).authorizeServerPage({ roles: ["admin", "boss"] })),
    "/dashboard",
  );
  const ok = await loadServerPageAuth({ getUser: signedIn }).authorizeServerPage({ roles: ["admin", "boss"] });
  assert.equal(ok.status, "ok");
  assert.equal(ok.role, "boss");
  assert.equal(ok.user.id, user.id);
});

test("every server-rendered dashboard page goes through the shared guard", () => {
  for (const page of [
    "src/app/(dashboard)/quotes/page.tsx",
    "src/app/(dashboard)/projects/page.tsx",
    "src/app/(dashboard)/settings/ads/page.tsx",
    "src/app/(dashboard)/cable-costing/page.tsx",
  ]) {
    const source = fs.readFileSync(path.join(ROOT, page), "utf8");
    assert.match(source, /authorizeServerPage\(/, page);
    assert.match(source, /session\.status === "unavailable"/, page);
    assert.doesNotMatch(source, /redirect\("\/login"\)/, `${page} must not decide "signed out" on its own`);
    assert.doesNotMatch(source, /auth\.getUser\(/, page);
  }
});

// ---------------------------------------------------------------------------
// src/lib/session-identity.ts: bounded retry + shared unavailable state (F-3)
// ---------------------------------------------------------------------------

function browser(t, responses) {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const store = new Map();
  globalThis.window = {
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    location: { reload() {} },
  };
  let calls = 0;
  globalThis.fetch = async () => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch; });
  return { count: () => calls };
}
const identity = { userId: "u1", email: null, role: "boss", isActive: true, forcePasswordChange: false, fullName: null };

test("the session reader retries an unavailable answer and resolves once the server answers", async (t) => {
  const calls = browser(t, [{ status: 503 }, new TypeError("fetch failed"), { status: 200, body: identity }]);
  const session = load("src/lib/session-identity.ts");
  let notified = 0;
  session.subscribeSessionUnavailable(() => { notified += 1; });
  const outcome = await session.readSessionIdentity({ retryDelaysMs: [0, 0] });
  assert.equal(outcome.status, "active");
  assert.equal(calls.count(), 3);
  assert.equal(session.isSessionUnavailable(), false);
  assert.equal(notified, 0, "a recovered read never publishes 'unavailable'");
});

test("after its retries are spent the reader reports unavailable and publishes it for the layout", async (t) => {
  const calls = browser(t, [{ status: 503 }]);
  const session = load("src/lib/session-identity.ts");
  let notified = 0;
  session.subscribeSessionUnavailable(() => { notified += 1; });
  assert.deepEqual(await session.readSessionIdentity({ retryDelaysMs: [0, 0] }), { status: "unavailable" });
  assert.equal(calls.count(), 3, "two retries, then give up");
  assert.equal(session.isSessionUnavailable(), true);
  assert.equal(notified, 1);
  assert.equal(session.SESSION_RETRY_DELAYS_MS.length, 2);
  assert.ok(session.SESSION_RETRY_DELAYS_MS.every((ms) => ms >= 1000 && ms <= 5000), "bounded back-off");
});

test("a definite refusal is never retried and clears the unavailable state", async (t) => {
  const calls = browser(t, [{ status: 503 }]);
  const session = load("src/lib/session-identity.ts");
  await session.readSessionIdentity({ retryDelaysMs: [0] });
  assert.equal(session.isSessionUnavailable(), true);
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  assert.deepEqual(await session.readSessionIdentity({ retryDelaysMs: [0] }), { status: "unauthenticated" });
  assert.equal(calls.count(), 2);
  assert.equal(session.isSessionUnavailable(), false);
});

test("the dashboard layout renders the shared connection-failed view for an unavailable session", () => {
  const layout = fs.readFileSync(path.join(ROOT, "src/app/(dashboard)/layout.tsx"), "utf8");
  assert.match(layout, /useSyncExternalStore\(subscribeSessionUnavailable, isSessionUnavailable/);
  assert.match(layout, /authError \|\| sessionUnavailable \? \(\s*<ConnectionFailed \/>/);
  const view = fs.readFileSync(path.join(ROOT, "src/components/ConnectionFailed.tsx"), "utf8");
  for (const key of ["common.connectionFailed", "common.connectionFailedHint", "common.retry"]) assert.match(view, new RegExp(`t\\("${key.replace(".", "\\.")}"\\)`));
  const translations = fs.readFileSync(path.join(ROOT, "src/lib/i18n/translations.ts"), "utf8");
  assert.equal((translations.match(/^\s*connectionFailed: "/gm) ?? []).length, 2, "both languages");
  assert.equal((translations.match(/^\s*connectionFailedHint: "/gm) ?? []).length, 2, "both languages");
});

// ---------------------------------------------------------------------------
// src/lib/deployment-skew.ts: F-4 (tab return probe), F-6 (no storage), F-7
// ---------------------------------------------------------------------------

function withEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

test("a tab returning to the foreground learns about a newer release but never reloads by itself", async (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-old");
  const previousWindow = globalThis.window;
  const store = new Map();
  let reloads = 0;
  globalThis.window = {
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    location: { reload: () => { reloads += 1; } },
  };
  t.after(() => { globalThis.window = previousWindow; });
  const skew = skewModule; skew.resetReleaseProbeForTests();
  let notified = 0;
  skew.subscribeUpdateAvailable(() => { notified += 1; });
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return new Response(null, { status: 401, headers: { "x-newme-deployment-id": "release-new" } }); };

  assert.equal(skew.isUpdateAvailable(), false);
  assert.equal(await skew.probeServerRelease({ fetchImpl, now: 1_000_000 }), true, "the header decides, not the status");
  assert.equal(reloads, 0, "the user may have unsaved input: no automatic reload on tab return");
  assert.equal(skew.isUpdateAvailable(), true);
  assert.equal(notified, 1);
  assert.equal(await skew.probeServerRelease({ fetchImpl, now: 1_000_000 + 1_000 }), false, "throttled");
  assert.equal(fetches, 1);
  await skew.probeServerRelease({ fetchImpl, now: 1_000_000 + skew.RELEASE_PROBE_INTERVAL_MS });
  assert.equal(fetches, 2);
  assert.equal(notified, 1, "published once");
  assert.equal(reloads, 0);

  // A matching release publishes nothing.
  skew.resetReleaseProbeForTests();
  const same = async () => new Response(null, { status: 200, headers: { "x-newme-deployment-id": "release-old" } });
  assert.equal(await skew.probeServerRelease({ fetchImpl: same, force: true }), false);
  assert.equal(skew.isUpdateAvailable(), false);

  const hook = fs.readFileSync(path.join(ROOT, "src/hooks/useVersionSkewReload.ts"), "utf8");
  assert.match(hook, /addEventListener\("visibilitychange", onReturn\)/);
  assert.match(hook, /addEventListener\("focus", onReturn\)/);
  assert.match(hook, /probeServerRelease\(\)/);
  const banner = fs.readFileSync(path.join(ROOT, "src/components/ReleaseUpdateBanner.tsx"), "utf8");
  assert.match(banner, /useSyncExternalStore\(subscribeUpdateAvailable, isUpdateAvailable/);
  assert.match(banner, /t\("common\.systemUpdatedRefresh"\)/);
  assert.match(banner, /window\.location\.reload\(\)/, "reload only on the user's click");
  const layout = fs.readFileSync(path.join(ROOT, "src/app/(dashboard)/layout.tsx"), "utf8");
  assert.match(layout, /<ReleaseUpdateBanner \/>/);
  const translations = fs.readFileSync(path.join(ROOT, "src/lib/i18n/translations.ts"), "utf8");
  assert.equal((translations.match(/^\s*systemUpdatedRefresh: "/gm) ?? []).length, 2, "both languages");
});

test("without usable sessionStorage no automatic reload is attempted, so a stale bundle can never loop", (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-old");
  const skew = skewModule; skew.resetReleaseProbeForTests();
  let reloads = 0;
  const location = { reload: () => { reloads += 1; } };
  assert.equal(skew.reloadOnceForVersionSkew({ storage: null, location }), false);
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };
  assert.equal(skew.reloadOnceForVersionSkew({ storage: throwing, location }), false);
  assert.equal(reloads, 0);
});

test("'Expected RSC response' alone is not treated as a release mismatch", (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-old");
  const skew = skewModule; skew.resetReleaseProbeForTests();
  assert.equal(skew.isVersionSkewError(new Error("Expected RSC response, got text/plain")), false);
  assert.equal(skew.isVersionSkewError(new Error('Failed to find Server Action "x". This request might be from an older or newer deployment.')), true);
});
