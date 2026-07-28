import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proxySource = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");

function loadProxy(mocks) {
  const ts = require("typescript");
  const filename = path.join(root, "src/proxy.ts");
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => Object.hasOwn(mocks, request)
    ? mocks[request]
    : previousLoad.call(Module, request, parent, isMain);
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

function request(pathname, method = "POST") {
  return {
    headers: new Headers(),
    method,
    nextUrl: { pathname },
    url: `https://app.newme.ae${pathname}`,
  };
}

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

function sessionToken(iat) {
  return `header.${Buffer.from(JSON.stringify({ iat })).toString("base64url")}.signature`;
}

function event() {
  return { waitUntil: () => {} };
}

function proxyForProfile({ profile, profileError = null, user = { id: "user-1" }, token = null }) {
  const supabase = {
    auth: {
      getUser: async () => ({ data: { user } }),
      getSession: async () => ({ data: { session: token ? { access_token: token } : null } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: profile, error: profileError }),
        }),
      }),
    }),
  };
  return loadProxy({
    "next/server": nextServer(),
    "@/lib/supabase-middleware": {
      createMiddlewareClient: async () => ({
        supabase,
        getResponse: () => ({ status: 200 }),
      }),
    },
    "@/lib/report-server-error": { reportServerError: async () => {} },
    "@/lib/auth-profile.mjs": { isActiveProfile: (candidate) => candidate?.is_active === true },
  });
}

test("unauthenticated business mutations fail closed while secret-authorized ingress stays reachable", async () => {
  const proxy = loadProxy({
    "next/server": nextServer(),
    "@/lib/supabase-middleware": {
      createMiddlewareClient: async () => ({
        supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
        getResponse: () => ({ status: 200 }),
      }),
    },
    "@/lib/report-server-error": { reportServerError: async () => {} },
    "@/lib/auth-profile.mjs": { isActiveProfile: () => false },
  });

  assert.deepEqual(await proxy.proxy(request("/api/leads/a/stage")), { body: { error: "unauthorized" }, status: 401 });
  assert.deepEqual(await proxy.proxy(request("/api/leads/meta-capi")), { status: 200 });
  assert.deepEqual(await proxy.proxy(request("/api/cron/check-no-answer", "GET")), { status: 200 });
});

test("a stalled auth dependency returns a bounded unavailable response for a business mutation", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return undefined;
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  const proxy = loadProxy({
    "next/server": nextServer(),
    "@/lib/supabase-middleware": {
      createMiddlewareClient: () => new Promise(() => {}),
    },
    "@/lib/report-server-error": { reportServerError: async () => {} },
    "@/lib/auth-profile.mjs": { isActiveProfile: () => false },
  });

  assert.deepEqual(await proxy.proxy(request("/api/leads/a/stage")), { body: { error: "auth_unavailable" }, status: 503 });
});

test("executed proxy authorization matrix keeps route policy and rejection types consistent", async () => {
  for (const role of ["boss", "admin", "operator"]) {
    const proxy = proxyForProfile({ profile: { role, is_active: true, password_changed_at: null } });
    assert.deepEqual(await proxy.proxy(request("/settings", "GET"), event()), { status: 200 }, `${role} may use settings`);
  }

  const sales = proxyForProfile({ profile: { role: "sales", is_active: true, password_changed_at: null } });
  assert.deepEqual(await sales.proxy(request("/settings", "GET"), event()), {
    location: "https://app.newme.ae/dashboard",
    status: 307,
  });
  assert.deepEqual(await sales.proxy(request("/pipeline", "GET"), event()), { status: 200 });
  assert.deepEqual(await sales.proxy(request("/api/leads", "GET"), event()), { status: 200 });

  const unauthenticated = proxyForProfile({ profile: null, user: null });
  assert.deepEqual(await unauthenticated.proxy(request("/settings", "GET"), event()), {
    location: "https://app.newme.ae/login?redirect=%2Fsettings",
    status: 307,
  });
  assert.deepEqual(await unauthenticated.proxy(request("/api/leads/a/stage"), event()), {
    body: { error: "unauthorized" },
    status: 401,
  });

  const inactive = proxyForProfile({ profile: { role: "admin", is_active: false, password_changed_at: null } });
  assert.deepEqual(await inactive.proxy(request("/settings", "GET"), event()), {
    location: "https://app.newme.ae/login?reason=inactive_account",
    status: 307,
  });
  assert.deepEqual(await inactive.proxy(request("/api/leads/a/stage"), event()), {
    body: { error: "inactive_account" },
    status: 401,
  });

  const profileFailure = proxyForProfile({ profile: null, profileError: new Error("profiles down") });
  assert.deepEqual(await profileFailure.proxy(request("/api/leads/a/stage"), event()), {
    body: { error: "auth_unavailable" },
    status: 503,
  });

  const passwordInvalidated = proxyForProfile({
    profile: { role: "admin", is_active: true, password_changed_at: "2026-07-28T00:00:01.000Z" },
    token: sessionToken(1),
  });
  assert.deepEqual(await passwordInvalidated.proxy(request("/settings", "GET"), event()), {
    location: "https://app.newme.ae/login?reason=password_changed",
    status: 307,
  });
  assert.deepEqual(await passwordInvalidated.proxy(request("/api/leads/a/stage"), event()), {
    body: { error: "password_changed" },
    status: 401,
  });

  const publicRoute = loadProxy({
    "next/server": nextServer(),
    "@/lib/supabase-middleware": { createMiddlewareClient: () => { throw new Error("must not run"); } },
    "@/lib/report-server-error": { reportServerError: async () => {} },
    "@/lib/auth-profile.mjs": { isActiveProfile: () => false },
  });
  assert.deepEqual(await publicRoute.proxy(request("/api/auth/me", "GET"), event()), { status: 200 });
});

test("activity and audit evidence use the server-only writer without a secret Bearer header", () => {
  assert.match(
    proxySource,
    /writeServerEvidence\(\s*"profiles"[\s\S]*writeServerEvidence\("audit_logs"/,
  );
  assert.match(proxySource, /headers:\s*\{[\s\S]*apikey: secretKey/);
  assert.doesNotMatch(
    proxySource,
    /Authorization:\s*`Bearer \$\{(?:secretKey|serviceRoleKey)\}`/,
  );
  assert.doesNotMatch(proxySource, /supabase\.from\("(?:profiles|audit_logs)"\)/);
});

test("server evidence writes survive the response and fail without blocking the page", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const requests = [];
  const reports = [];
  let background;

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://cleanroom.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_only";
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 403 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  });

  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
      getSession: async () => ({ data: { session: null } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              role: "admin",
              is_active: true,
              password_changed_at: null,
            },
            error: null,
          }),
        }),
      }),
    }),
  };
  const proxy = loadProxy({
    "next/server": nextServer(),
    "@/lib/supabase-middleware": {
      createMiddlewareClient: async () => ({
        supabase,
        getResponse: () => ({ status: 200 }),
      }),
    },
    "@/lib/report-server-error": {
      reportServerError: async (report) => {
        reports.push(report);
      },
    },
    "@/lib/auth-profile.mjs": { isActiveProfile: () => true },
  });

  const response = await proxy.proxy(
    request("/dashboard", "GET"),
    { waitUntil: (promise) => { background = promise; } },
  );
  assert.deepEqual(response, { status: 200 });
  assert.ok(background, "proxy must register evidence writes with waitUntil");
  await background;

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ url, init }) => ({
      url,
      method: init.method,
      apikey: init.headers.apikey,
      authorization: init.headers.Authorization,
    })),
    [
      {
        url: "https://cleanroom.example/rest/v1/profiles?id=eq.user-1",
        method: "PATCH",
        apikey: "sb_secret_test_only",
        authorization: undefined,
      },
      {
        url: "https://cleanroom.example/rest/v1/audit_logs",
        method: "POST",
        apikey: "sb_secret_test_only",
        authorization: undefined,
      },
    ],
  );
  assert.deepEqual(
    reports.map(({ type }) => type).sort(),
    ["activity_tracking_error", "audit_log_error"],
  );
});

