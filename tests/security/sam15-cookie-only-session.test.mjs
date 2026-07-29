import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseAuthSessionCookie } from "../../src/lib/auth-cookie.mjs";

const root = new URL("../../", import.meta.url);
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

function createCookieResponseMock() {
  class MockResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.headers = new Headers();
      this.cookiesSet = [];
      this.cookies = {
        set: (name, value, options = {}) => {
          this.cookiesSet.push({ name, value, options });
          const serialized = this.cookiesSet.map((cookie) => {
            const attributes = [
              `Path=${cookie.options.path ?? "/"}`,
              `Max-Age=${cookie.options.maxAge ?? 0}`,
              cookie.options.httpOnly ? "HttpOnly" : "",
              cookie.options.sameSite ? `SameSite=${cookie.options.sameSite}` : "",
              cookie.options.secure ? "Secure" : "",
            ].filter(Boolean);
            return `${cookie.name}=${encodeURIComponent(cookie.value)}; ${attributes.join("; ")}`;
          }).join(", ");
          this.headers.set("set-cookie", serialized);
        },
      };
    }

    async json() {
      return this.body;
    }
  }

  return {
    NextResponse: {
      json(body, init) {
        return new MockResponse(body, init);
      },
    },
  };
}

function cookieHeaderFromSetCookie(response) {
  return response.headers
    .get("set-cookie")
    .split(/,\s*(?=[^;]+=)/)
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

test("browser-readable session cookie contains no refresh token", async () => {
  const names = { authToken: "sb-demo-auth-token", refreshToken: "sb-demo-refresh-token" };
  const session = loadTypeScriptModule("src/app/api/auth/session/route.ts", {
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "next/server": createCookieResponseMock(),
  });
  const response = await session.POST(new Request("http://localhost/api/auth/session", {
    body: JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));

  const readable = response.cookiesSet
    .filter((cookie) => cookie.options.httpOnly !== true)
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
    .join("; ");
  assert.doesNotMatch(readable, /refresh-token|refresh_token/);
  const parsed = parseAuthSessionCookie(readable, names.authToken);
  assert.equal(parsed?.access_token, "access-token");
  assert.equal(typeof parsed?.expires_at, "number");
  assert.equal(Object.hasOwn(parsed ?? {}, "refresh_token"), false);
  assert.equal(response.cookiesSet.find((cookie) => cookie.name === names.refreshToken).options.httpOnly, true);
});

test("configured public origin is accepted behind a reverse proxy and other origins are rejected", async (t) => {
  const names = { authToken: "sb-demo-auth-token", refreshToken: "sb-demo-refresh-token" };
  const session = loadTypeScriptModule("src/app/api/auth/session/route.ts", {
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "next/server": createCookieResponseMock(),
  });
  const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://app.newme.ae";
  t.after(() => {
    if (previousSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
  });

  const request = (origin) => new Request("http://127.0.0.1/api/auth/session", {
    body: JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  });
  const accepted = await session.POST(request("https://app.newme.ae"));
  assert.equal(accepted.status, 200);
  const rejected = await session.POST(request("https://evil.example"));
  assert.equal(rejected.status, 403);
});

test("URI-encoded Set-Cookie wire format reaches auth/me and refresh survives auth-cookie loss", async (t) => {
  const names = { authToken: "sb-demo-auth-token", refreshToken: "sb-demo-refresh-token" };
  const nextServer = createCookieResponseMock();
  const session = loadTypeScriptModule("src/app/api/auth/session/route.ts", {
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "next/server": nextServer,
  });
  const sessionResponse = await session.POST(new Request("http://localhost/api/auth/session", {
    body: JSON.stringify({
      access_token: "access token",
      refresh_token: "refresh token",
      expires_in: 3600,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
  const wireCookieHeader = cookieHeaderFromSetCookie(sessionResponse);
  assert.match(wireCookieHeader, /%7B/);

  let capturedHeaders;
  const server = loadTypeScriptModule("src/lib/supabase-server.ts", {
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "@/lib/auth-refresh.mjs": { classifyRefreshFailure: () => "upstream_error" },
    "@/lib/organization-context": {
      ORGANIZATION_CONTEXT_COOKIE: "newme-organization-id",
      ORGANIZATION_CONTEXT_HEADER: "x-newme-organization-id",
      parseOrganizationId: (value) =>
        typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
          ? value
          : null,
    },
    "@supabase/supabase-js": {
      createClient: (_url, _key, options) => {
        capturedHeaders = options.global.headers;
        return { auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.com" } }, error: null }) } };
      },
    },
    "next/headers": { cookies: async () => ({ getAll: () => [] }) },
  });
  const parsedClient = await server.createServerSupabase(undefined, wireCookieHeader);
  assert.equal(capturedHeaders.Authorization, "Bearer access token");

  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://test.supabase.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceKey;
  });

  const authMe = loadTypeScriptModule("src/app/api/auth/me/route.ts", {
    "@/lib/supabase-server": {
      createServerSupabase: async () => parsedClient,
      getRefreshedCookies: () => [],
      getRefreshAttempted: () => false,
      getRefreshFailure: () => undefined,
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "@/lib/logger": { logger: { error: () => {}, info: () => {}, warn: () => {} } },
    "@supabase/supabase-js": {
      createClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { role: "sales", is_active: true, force_password_change: false, full_name: "Owner", email: "owner@example.com" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    },
    "next/server": createCookieResponseMock(),
  });
  const authResponse = await authMe.GET(new Request("http://localhost/api/auth/me", {
    headers: { cookie: wireCookieHeader },
  }));
  assert.equal(authResponse.status, 200);
  assert.equal((await authResponse.json()).isActive, true);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 3600 }),
  });

  for (const authCookie of [
    `${names.authToken}=${encodeURIComponent(JSON.stringify({ access_token: "expired-access", expires_at: 1 }))}`,
    "",
  ]) {
    capturedHeaders = undefined;
    const refreshOnlyHeader = [authCookie, `${names.refreshToken}=refresh-token`].filter(Boolean).join("; ");
    const refreshedClient = await server.createServerSupabase(undefined, refreshOnlyHeader);
    assert.equal(capturedHeaders.Authorization, "Bearer refreshed-access");

    const refreshedCookies = server.getRefreshedCookies(refreshedClient);
    const authCookieResult = refreshedCookies.find((cookie) => cookie.name === names.authToken);
    const refreshCookieResult = refreshedCookies.find((cookie) => cookie.name === names.refreshToken);
    assert.equal(authCookieResult?.options.httpOnly, false);
    assert.equal(refreshCookieResult?.options.httpOnly, true);
    assert.equal(refreshCookieResult?.value, "refreshed-refresh");
    const parsedRefresh = parseAuthSessionCookie(
      names.authToken + "=" + encodeURIComponent(authCookieResult?.value ?? ""),
      names.authToken,
    );
    assert.equal(parsedRefresh?.access_token, "refreshed-access");
    assert.equal(Object.hasOwn(parsedRefresh ?? {}, "refresh_token"), false);
  }
});

test("cookie-only browser session does not use localStorage or client persistence", async () => {
  const [login, client, logout, session, server, redirect, posthog] = await Promise.all([
    readFile(new URL("src/app/login/page.tsx", root), "utf8"),
    readFile(new URL("src/lib/supabase.ts", root), "utf8"),
    readFile(new URL("src/app/api/auth/logout/route.ts", root), "utf8"),
    readFile(new URL("src/app/api/auth/session/route.ts", root), "utf8"),
    readFile(new URL("src/lib/supabase-server.ts", root), "utf8"),
    readFile(new URL("src/hooks/useAuthRedirect.ts", root), "utf8"),
    readFile(new URL("src/components/PostHogProviderInner.tsx", root), "utf8"),
  ]);

  assert.doesNotMatch(login, /localStorage/);
  assert.doesNotMatch(client, /localStorage|storage:/);
  assert.match(client, /Authorization:.*nextToken/);
  assert.match(client, /persistSession: false/);
  assert.match(logout, /getSupabaseCookieNames/);
  assert.match(session, /httpOnly: true/);
  assert.match(server, /decodeURIComponent/);
  assert.match(login, /fetch\(["']\/api\/auth\/logout/);
  assert.match(login, /auth\/v1\/logout/);
  assert.doesNotMatch(redirect, /localStorage|auth-token/);
  assert.doesNotMatch(posthog, /localStorage|access_token|atob\(/);
  assert.match(posthog, /fetch\(["']\/api\/auth\/me/);
});

test("server component refresh path never writes through the read-only cookies store", async (t) => {
  const names = { authToken: "sb-demo-auth-token", refreshToken: "sb-demo-refresh-token" };
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const previousFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://test.supabase.local";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 3600 }),
  });

  const cookieStore = {
    getAll: () => [
      { name: names.authToken, value: JSON.stringify({ access_token: "expired-access", expires_at: 1 }) },
      { name: names.refreshToken, value: "refresh-token" },
    ],
    set: () => {
      throw new Error("Server Component cookie store must remain read-only");
    },
  };
  const server = loadTypeScriptModule("src/lib/supabase-server.ts", {
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "@/lib/auth-refresh.mjs": { classifyRefreshFailure: () => "upstream_error" },
    "@/lib/organization-context": {
      ORGANIZATION_CONTEXT_COOKIE: "newme-organization-id",
      ORGANIZATION_CONTEXT_HEADER: "x-newme-organization-id",
      parseOrganizationId: (value) =>
        typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
          ? value
          : null,
    },
    "@supabase/supabase-js": { createClient: (_url, _key, options) => ({ options }) },
    "next/headers": { cookies: async () => cookieStore },
  });

  const client = await server.createServerSupabase();
  assert.equal(client.options.global.headers.Authorization, "Bearer refreshed-access");
  assert.equal(server.getRefreshedCookies(client).length, 2);
});

test("middleware passes the explicit Cookie header and writes custom refresh cookies both ways", async () => {
  const requestCookies = [];
  let receivedCookieHeader;
  class MockResponse {
    constructor(request) {
      this.request = request;
      this.cookiesSet = [];
      this.headers = new Headers();
      this.cookies = {
        set: (name, value, options = {}) => this.cookiesSet.push({ name, value, options }),
      };
    }
  }
  const refreshedCookies = [
    { name: "sb-auth", value: "new-access", options: { httpOnly: false } },
    { name: "sb-refresh", value: "new-refresh", options: { httpOnly: true } },
  ];
  const middleware = loadTypeScriptModule("src/lib/supabase-middleware.ts", {
    "@/lib/supabase-server": {
      createServerSupabase: async (_bearerToken, cookieHeader) => {
        receivedCookieHeader = cookieHeader;
        return { refreshedCookies };
      },
      getRefreshedCookies: (client) => client.refreshedCookies,
    },
    "next/server": {
      NextResponse: {
        next: ({ request }) => new MockResponse(request),
      },
    },
  });
  const request = {
    headers: new Headers({ cookie: "sb-auth=old-access; sb-refresh=old-refresh" }),
    cookies: {
      getAll: () => requestCookies,
      set: (name, value) => requestCookies.push({ name, value }),
    },
  };
  const { getResponse } = await middleware.createMiddlewareClient(request);

  assert.equal(receivedCookieHeader, "sb-auth=old-access; sb-refresh=old-refresh");
  assert.deepEqual(requestCookies, [
    { name: "sb-auth", value: "new-access" },
    { name: "sb-refresh", value: "new-refresh" },
  ]);
  assert.deepEqual(getResponse().cookiesSet, refreshedCookies);
});

test("same-origin logout revokes the current Supabase session and clears all cookies", async (t) => {
  const names = { authToken: "sb-demo-auth-token", refreshToken: "sb-demo-refresh-token" };
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://demo.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
  });

  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return { ok: true };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const logout = loadTypeScriptModule("src/app/api/auth/logout/route.ts", {
    "@/lib/supabase-server": {
      extractSessionTokensFromCookieHeader: () => ({
        accessToken: "cookie-access-token",
        refreshToken: "cookie-refresh-token",
      }),
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "next/server": createCookieResponseMock(),
  });
  const response = await logout.POST(new Request("http://localhost/api/auth/logout", {
    headers: { cookie: "session=cookie" },
    method: "POST",
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revoked: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://demo.supabase.co/auth/v1/logout?scope=local");
  assert.equal(requests[0].init.headers.apikey, "test-anon-key");
  assert.equal(requests[0].init.headers.Authorization, "Bearer cookie-access-token");
  assert.deepEqual(
    response.cookiesSet.map((cookie) => cookie.name),
    [names.authToken, names.refreshToken, "sb-access-token", "sb-refresh-token"],
  );
  assert.ok(response.cookiesSet.every((cookie) => cookie.value === "" && cookie.options.maxAge === 0));
});

test("logout refreshes an expired cookie session before revocation", async (t) => {
  const names = { authToken: "sb-demo-auth-token", refreshToken: "sb-demo-refresh-token" };
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://demo.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
  });

  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("grant_type=refresh_token")) {
      return {
        ok: true,
        json: async () => ({ access_token: "refreshed-access-token" }),
      };
    }
    return { ok: true };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const logout = loadTypeScriptModule("src/app/api/auth/logout/route.ts", {
    "@/lib/supabase-server": {
      extractSessionTokensFromCookieHeader: () => ({
        refreshToken: "cookie-refresh-token",
      }),
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "next/server": createCookieResponseMock(),
  });
  const response = await logout.POST(new Request("http://localhost/api/auth/logout", {
    headers: { cookie: "session=cookie" },
    method: "POST",
  }));

  assert.deepEqual(await response.json(), { ok: true, revoked: true });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    "https://demo.supabase.co/auth/v1/token?grant_type=refresh_token",
  );
  assert.equal(requests[1].url, "https://demo.supabase.co/auth/v1/logout?scope=local");
  assert.equal(requests[1].init.headers.Authorization, "Bearer refreshed-access-token");
});

test("logout clears cookies when Supabase Auth is unavailable", async (t) => {
  const names = { authToken: "sb-demo-auth-token", refreshToken: "sb-demo-refresh-token" };
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://demo.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("upstream unavailable");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const logout = loadTypeScriptModule("src/app/api/auth/logout/route.ts", {
    "@/lib/supabase-server": {
      extractSessionTokensFromCookieHeader: () => ({ accessToken: "cookie-access-token" }),
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "next/server": createCookieResponseMock(),
  });
  const response = await logout.POST(new Request("http://localhost/api/auth/logout", {
    headers: { cookie: "session=cookie" },
    method: "POST",
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revoked: false });
  assert.ok(response.cookiesSet.every((cookie) => cookie.value === "" && cookie.options.maxAge === 0));
});
