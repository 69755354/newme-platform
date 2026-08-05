import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const read = (path) => fs.readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const source = fsSync.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
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

function createNextServerMock() {
  class MockResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.headers = new Headers(init.headers);
      this.cookies = { set: () => {} };
    }

    async json() {
      return this.body;
    }
  }

  return {
    NextRequest: class {},
    NextResponse: {
      json(body, init) {
        return new MockResponse(body, init);
      },
    },
  };
}

function createSupabaseMock(getActive) {
  return {
    auth: {
      async getUser() {
        return {
          data: { user: { id: "user-1", email: "owner@example.com" } },
          error: null,
        };
      },
    },
    from(table) {
      assert.equal(table, "profiles");
      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  return {
                    data: {
                      email: "owner@example.com",
                      force_password_change: false,
                      full_name: "Historical Owner",
                      is_active: getActive(),
                      role: "sales",
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

test("inactive users are denied at the direct protected lead-stage API boundary", async () => {
  const { isActiveProfile } = await import("../../src/lib/auth-profile.mjs");
  const [auth, route] = await Promise.all([
    read("src/lib/lead-auth.ts"),
    read("src/app/api/leads/[id]/stage/route.ts"),
  ]);

  assert.equal(isActiveProfile({ is_active: false }), false);
  assert.equal(isActiveProfile({ is_active: true }), true);
  assert.match(auth, /select\(["']role, is_active["']\)/);
  assert.match(auth, /isActiveProfile\(profile\)/);
  assert.match(route, /getRequestAuthContext\(req\)/);
  assert.match(route, /requestAuthErrorResponse\(error\)/);
});

test("the server proxy denies inactive sessions before protected APIs or pages", async () => {
  const proxy = await read("src/proxy.ts");

  assert.match(proxy, /isActiveProfile\(profile\)/);
  assert.match(proxy, /pathname\.startsWith\(["']\/api\//);
  assert.match(proxy, /status: 401/);
  assert.match(proxy, /reason["']?, ["']inactive_account["']/);
  assert.match(proxy, /const PUBLIC_API_PATHS = new Set\(\[\s*["']\/api\/auth\/logout["']\s*,\s*["']\/api\/auth\/me["']\s*,?\s*\]\)/);
  assert.match(proxy, /EXTERNAL_AUTHORIZED_API_PATHS/);
  assert.match(proxy, /"\/api\/leads\/meta-capi"/);
  assert.match(proxy, /EXTERNAL_AUTHORIZED_API_PREFIXES = \["\/api\/cron\/"\]/);
  assert.ok(proxy.indexOf("isActiveProfile(profile)") < proxy.indexOf("Track activity"));
});

test("login and the dashboard guard require an active /api/auth/me result", async () => {
  const [login, authMe, hook] = await Promise.all([
    read("src/app/login/page.tsx"),
    read("src/app/api/auth/me/route.ts"),
    read("src/hooks/useAuthRedirect.ts"),
  ]);

  assert.match(login, /\/api\/auth\/me/);
  assert.match(login, /Authorization["']\s*:\s*[`"']Bearer/);
  assert.match(login, /revokeRejectedSession\(data\.access_token\)/);
  assert.match(login, /\/auth\/v1\/logout/);
  assert.match(authMe, /profile(?:\?\.)?\.is_active !== true/);
  assert.match(authMe, /status: 401/);
  assert.match(hook, /data\.isActive !== true/);
});

test("real lead stage handler rejects an inactive old session before business access", async () => {
  let active = false;
  const supabase = createSupabaseMock(() => active);
  const nextServer = createNextServerMock();
  class MockRequestAuthError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
      this.status = 401;
    }
  }
  const requestAuth = {
    applyRequestAuthCookies: (_context, response) => response,
    async getRequestAuthContext() {
      if (!active) throw new MockRequestAuthError("inactive_account");
      return {
        profile: { is_active: true, role: "sales" },
        refreshedCookies: [],
        role: "sales",
        supabase,
        user: { id: "user-1" },
      };
    },
    RequestAuthError: MockRequestAuthError,
    requestAuthErrorResponse: (error) => nextServer.NextResponse.json(
      { error: error.code },
      { status: error.status },
    ),
  };
  const stage = loadTypeScriptModule("src/app/api/leads/[id]/stage/route.ts", {
    "@/lib/first-contact-gate.mjs": {
      evaluateFirstContactGate: () => ({ allowed: true, reasons: [] }),
      isCompleteContact: () => true,
    },
    "@/lib/logger": {
      logger: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
      genReqId: () => "test-rid",
    },
    "@/lib/request-auth-context": requestAuth,
    "@/shared/kanban/types": { PIPELINE_STAGES: [{ key: "new" }] },
    "next/server": nextServer,
  });

  const request = () => new Request("http://localhost/api/leads/lead-1/stage", {
    body: JSON.stringify({ note: "attempt", stage: "not-a-real-stage" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const params = { params: Promise.resolve({ id: "lead-1" }) };

  const inactiveResponse = await stage.PATCH(request(), params);
  assert.equal(inactiveResponse.status, 401);
  assert.deepEqual(await inactiveResponse.json(), { error: "inactive_account" });

  active = true;
  const activeResponse = await stage.PATCH(request(), params);
  assert.equal(activeResponse.status, 400);
  assert.deepEqual(await activeResponse.json(), { error: "A valid idempotency key is required" });
});

test("real auth-me handler rejects an inactive old token and accepts an active profile", async (t) => {
  // route.ts:29-33 reads these at request time and returns 500 if absent.
  // Save/restore to avoid polluting other tests in the suite.
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://test.supabase.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  t.after(() => {
    if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });

  let active = false;
  const supabase = createSupabaseMock(() => active);
  const nextServer = createNextServerMock();

  // After 2026-07-20 3rd hotfix, /api/auth/me uses service_role admin client
  // (createClient from @supabase/supabase-js) for profiles lookup.
  // The test must mock createClient to simulate admin profile responses.
  const mockCreateClient = () => ({
    from(table) {
      assert.equal(table, "profiles");
      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  return active
                    ? { data: { role: "admin", is_active: true, force_password_change: false, full_name: "Test User", email: "test@example.com" }, error: null }
                    : { data: { role: "sales", is_active: false, force_password_change: false, full_name: "Inactive User", email: "test@example.com" }, error: null };
                },
              };
            },
          };
        },
      };
    },
  });

  const authMe = loadTypeScriptModule("src/app/api/auth/me/route.ts", {
    "@/lib/supabase-server": { createServerSupabase: async () => supabase, getRefreshedCookies: () => [], getRefreshAttempted: () => false, getRefreshFailure: () => undefined },
    "@/lib/supabase-cookie-names": {
      getSupabaseCookieNames: () => ({ authToken: "sb-test-auth-token", refreshToken: "sb-test-refresh-token" }),
    },
    "@/lib/logger": { logger: { error: () => {}, info: () => {}, warn: () => {} } },
    "next/server": nextServer,
    "@supabase/supabase-js": { createClient: mockCreateClient },
  });
  const request = () => new Request("http://localhost/api/auth/me", {
    headers: { Authorization: "Bearer old-access-token" },
  });

  const inactiveResponse = await authMe.GET(request());
  assert.equal(inactiveResponse.status, 401);
  assert.equal((await inactiveResponse.json()).error, "inactive_account");

  active = true;
  const activeResponse = await authMe.GET(request());
  assert.equal(activeResponse.status, 200);
  assert.equal((await activeResponse.json()).isActive, true);
});
