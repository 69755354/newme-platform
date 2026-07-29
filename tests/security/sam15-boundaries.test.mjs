import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const read = (file) => fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const { outputText } = ts.transpileModule(fsSync.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
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

function nextResponseMock() {
  return {
    NextResponse: {
      json: (body, init = {}) => new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      }),
    },
  };
}

function loadNextConfig() {
  return loadTypeScriptModule("next.config.ts", {
    "@next/bundle-analyzer": () => (config) => config,
    "@sentry/nextjs": { withSentryConfig: (config) => config },
    child_process: { execSync: () => Buffer.from("7f3e2fa") },
    fs: { existsSync: () => false },
  });
}

test("health endpoint exposes only a minimal public status", async () => {
  const source = await read("src/app/api/health/route.ts");
  assert.match(source, /status: "ok"/);
  assert.doesNotMatch(source, /service:|version:|release|uptime|checks|process\.cwd|fs\.writeFile|errMsg/);
});

test("readiness rejects unauthenticated probes and bounds a stalled dependency", async (t) => {
  const oldToken = process.env.NEWME_READINESS_TOKEN;
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const oldFetch = globalThis.fetch;
  const oldSetTimeout = globalThis.setTimeout;
  t.after(() => {
    if (oldToken === undefined) delete process.env.NEWME_READINESS_TOKEN; else process.env.NEWME_READINESS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
    globalThis.fetch = oldFetch;
    globalThis.setTimeout = oldSetTimeout;
  });
  process.env.NEWME_READINESS_TOKEN = "test-readiness-token";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true }; };
  const ready = loadTypeScriptModule("src/app/api/ready/route.ts", { "next/server": nextResponseMock() });
  const unauthenticated = await ready.GET(new Request("https://app.example/api/ready"));
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { status: "unauthorized" });
  assert.equal(calls, 0);

  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 0;
  };
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });
  const timedOut = await ready.GET(new Request("https://app.example/api/ready", {
    headers: { "x-newme-readiness-token": "test-readiness-token" },
  }));
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), { status: "degraded" });
});

test("production headers include CSP and HSTS", async () => {
  const source = await read("next.config.ts");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /Strict-Transport-Security/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /upgrade-insecure-requests/);
  assert.match(source, /eu-assets\.i\.posthog\.com/);
});

test("non-production CSP allows only the exact configured loopback Supabase origin", async (t) => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  t.after(() => {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    if (oldSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldSupabaseUrl;
  });
  process.env.NODE_ENV = "development";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";

  const config = loadNextConfig();
  assert.equal(
    config.getLocalSupabaseConnectOrigin("test", "http://localhost:54321/"),
    "http://localhost:54321",
  );
  const headers = await config.default.headers();
  const csp = headers[0].headers.find(({ key }) => key === "Content-Security-Policy").value;
  assert.match(csp, /connect-src [^;]*http:\/\/127\.0\.0\.1:54321(?:;| )/);
  assert.doesNotMatch(csp, /http:\/\/127\.0\.0\.1:\*|http:\/\/localhost:\*/);
});

test("production and invalid Supabase URLs never relax CSP connect-src", () => {
  const config = loadNextConfig();
  const rejected = [
    ["production", "http://127.0.0.1:54321"],
    ["development", "https://127.0.0.1:54321"],
    ["development", "http://127.0.0.1.evil.example:54321"],
    ["development", "http://user:password@127.0.0.1:54321"],
    ["development", "http://localhost"],
    ["development", "http://localhost:54321/path"],
    ["development", "http://localhost:54321/?query=1"],
    ["development", "http://192.168.1.20:54321"],
    ["development", "not a url"],
  ];
  for (const [nodeEnv, url] of rejected) {
    assert.equal(config.getLocalSupabaseConnectOrigin(nodeEnv, url), undefined, `${nodeEnv}: ${url}`);
    const csp = config.buildContentSecurityPolicy(nodeEnv, url);
    assert.doesNotMatch(csp, /127\.0\.0\.1|localhost|192\.168\.1\.20/);
  }
});

test("Sentry source-map upload is disabled without explicit release credentials", async () => {
  const source = await read("next.config.ts");
  assert.match(source, /SENTRY_UPLOAD_SOURCEMAPS === "1"/);
  assert.match(source, /!shouldUploadSentrySourceMaps \? nextConfig : withSentryConfig/);
});

test("session cookies use dynamic names and secure server refresh attributes", async () => {
  const cookieNames = await read("src/lib/supabase-cookie-names.ts");
  const server = await read("src/lib/supabase-server.ts");
  const session = await read("src/app/api/auth/session/route.ts");
  assert.match(cookieNames, /new URL\(supabaseUrl/);
  assert.doesNotMatch(cookieNames + server + session, /vfopmpxlhwzpxqegayew/);
  assert.match(server, /httpOnly: true/);
  assert.match(session, /JSON\.stringify\(\{[\s\S]*access_token: accessToken/);
  assert.doesNotMatch(session, /const cookiePayload = JSON\.stringify\(\{[\s\S]*refresh_token: refreshToken/);
  assert.doesNotMatch(server, /_cookieStore\.set/);
  assert.match(session, /httpOnly: true/);
  assert.match(session, /sameSite: "strict"/);
  assert.match(session, /secure: true/);
});

test("middleware uses the custom split-session refresh boundary", async () => {
  const middleware = await read("src/lib/supabase-middleware.ts");
  assert.match(middleware, /createServerSupabase\(bearerToken, request\.headers\.get\("cookie"\)/);
  assert.match(middleware, /getRefreshedCookies\(supabase\)/);
  assert.match(middleware, /request\.cookies\.set\(name, value\)/);
  assert.match(middleware, /response\.cookies\.set\(name, value, options/);
  assert.doesNotMatch(middleware, /@supabase\/ssr|CookieOptions|setAll/);
  assert.match(middleware, /getResponse: \(\) => response/);
  const proxy = await read("src/proxy.ts");
  assert.doesNotMatch(proxy, /const \{ supabase, response \}/);
  assert.match(proxy, /createMiddlewareClient\(request, bearerToken\)/);
  assert.match(proxy, /const \{ supabase, getResponse \} = middlewareClient/);
  assert.match(proxy, /return getResponse\(\)/);
});

test("login delegates cookie creation to the same-origin server endpoint", async () => {
  const login = await read("src/app/login/page.tsx");
  const proxy = await read("src/proxy.ts");
  assert.match(login, /\/api\/auth\/session/);
  assert.doesNotMatch(login, /document\.cookie\s*=.*refresh/);
  assert.match(proxy, /"\/api\/auth\/session"/);
});

test("session cookie payload is consumable by the SSR token parser contract", async () => {
  const session = await read("src/app/api/auth/session/route.ts");
  const server = await read("src/lib/supabase-server.ts");
  const payload = JSON.stringify({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.access_token, "access-token");
  assert.equal(parsed.refresh_token, "refresh-token");
  assert.match(session, /const cookiePayload = JSON\.stringify\(\{[\s\S]*access_token: accessToken,\s*expires_at:/);
  assert.doesNotMatch(session, /const cookiePayload = JSON\.stringify\(\{[\s\S]*refresh_token: refreshToken/);
  assert.match(session, /response\.cookies\.set\(refreshCookie, refreshToken/);
  assert.match(server, /parseSsrCookie/);
});
