import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server.js";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const source = fsSync.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
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

function makeSupabase(role, authenticated = true) {
  return {
    auth: { getUser: async () => ({ data: { user: authenticated ? { id: "user-1" } : null }, error: authenticated ? null : new Error("auth failure") }) },
    from(table) {
      assert.equal(table, "profiles");
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { role, is_active: true }, error: null }) }) }) };
    },
  };
}

function stateFromStart(response) {
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.match(/meta_oauth_state=([^;]+)/)?.[1];
  assert.ok(cookie);
  return cookie;
}

function assertStateCleared(response) {
  assert.match(response.headers.get("set-cookie") || "", /meta_oauth_state=;[^\n]*Max-Age=0/);
}

test("OAuth start is authorized for boss/admin only and binds state", async (t) => {
  const oldAppId = process.env.META_APP_ID;
  const oldRedirect = process.env.META_REDIRECT_URI;
  process.env.META_APP_ID = "test-app-id";
  process.env.META_REDIRECT_URI = "https://app.newme.ae/api/meta/oauth-callback";
  t.after(() => {
    if (oldAppId === undefined) delete process.env.META_APP_ID; else process.env.META_APP_ID = oldAppId;
    if (oldRedirect === undefined) delete process.env.META_REDIRECT_URI; else process.env.META_REDIRECT_URI = oldRedirect;
  });

  let role = "boss";
  let authenticated = true;
  const start = loadTypeScriptModule("src/app/api/meta/oauth-start/route.ts", {
    "@/lib/supabase-server": { createServerSupabase: async () => makeSupabase(role, authenticated) },
  });
  const request = () => new NextRequest("https://app.newme.ae/api/meta/oauth-start", { headers: { cookie: "session=valid" } });
  const allowed = await start.GET(request());
  assert.equal(allowed.status, 307);
  const location = new URL(allowed.headers.get("location"));
  assert.equal(location.origin, "https://www.facebook.com");
  assert.equal(location.searchParams.get("state"), stateFromStart(allowed));
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.match(allowed.headers.get("set-cookie") || "", /HttpOnly/);
  assert.match(allowed.headers.get("set-cookie") || "", /SameSite=lax/i);
  assert.match(allowed.headers.get("set-cookie") || "", /Secure/);

  authenticated = false;
  const unauthenticated = await start.GET(request());
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("location"), null);
  assert.doesNotMatch(unauthenticated.headers.get("set-cookie") || "", /meta_oauth_state/);

  authenticated = true;
  role = "sales";
  const denied = await start.GET(request());
  assert.equal(denied.status, 403);
});

test("OAuth callback rejects missing/mismatched state, succeeds once, and clears the cookie", async (t) => {
  const oldAppId = process.env.META_APP_ID;
  const oldSecret = process.env.META_APP_SECRET;
  const oldRedirect = process.env.META_REDIRECT_URI;
  const oldSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-secret";
  process.env.META_REDIRECT_URI = "https://app.newme.ae/api/meta/oauth-callback";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  t.after(() => {
    for (const [key, value] of Object.entries({ META_APP_ID: oldAppId, META_APP_SECRET: oldSecret, META_REDIRECT_URI: oldRedirect, NEXT_PUBLIC_SUPABASE_URL: oldSupabaseUrl, SUPABASE_SERVICE_ROLE_KEY: oldSupabaseKey })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  let fetchCalls = 0;
  let throwFetch = false;
  let writes = 0;
  const callback = loadTypeScriptModule("src/app/api/meta/oauth-callback/route.ts", {
    "@/lib/logger": { logger: { error: () => {}, info: () => {}, warn: () => {} }, genReqId: () => "test-request" },
    "@supabase/supabase-js": { createClient: () => ({ from: () => ({ upsert: async () => { writes++; return { error: null }; } }) }) },
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    fetchCalls++;
    if (throwFetch) throw new Error("<script>internal-exception-text</script>");
    return { ok: true, json: async () => fetchCalls === 1 ? { access_token: "short-token" } : { access_token: "long-token", expires_in: 3600 } };
  };

  const state = "state-for-test";
  const cookie = `meta_oauth_state=${state}`;
  const request = (queryState, code = "oauth-code", cookieHeader = cookie) => new NextRequest(
    `https://app.newme.ae/api/meta/oauth-callback?code=${code}&state=${encodeURIComponent(queryState)}`,
    { headers: cookieHeader ? { cookie: cookieHeader } : {} },
  );

  const missing = await callback.GET(new NextRequest("https://app.newme.ae/api/meta/oauth-callback?code=oauth-code"));
  assert.equal(missing.status, 400);
  assertStateCleared(missing);
  assert.equal(fetchCalls, 0);

  const mismatch = await callback.GET(request("wrong-state"));
  assert.equal(mismatch.status, 400);
  assertStateCleared(mismatch);
  assert.equal(fetchCalls, 0);

  const maliciousError = await callback.GET(new NextRequest(
    `https://app.newme.ae/api/meta/oauth-callback?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&error_description=%3Cscript%3Ealert(2)%3C%2Fscript%3E&state=${state}`,
    { headers: { cookie } },
  ));
  assert.equal(maliciousError.status, 200);
  const maliciousBody = await maliciousError.text();
  assert.doesNotMatch(maliciousBody, /<img|<script|onerror|alert\(/i);
  assert.match(maliciousBody, /Authorization Failed/);
  assertStateCleared(maliciousError);
  assert.equal(fetchCalls, 0);

  throwFetch = true;
  const exchangeFailure = await callback.GET(request(state));
  assert.equal(exchangeFailure.status, 200);
  const exchangeFailureBody = await exchangeFailure.text();
  assert.doesNotMatch(exchangeFailureBody, /<script|internal-exception-text/i);
  assertStateCleared(exchangeFailure);
  assert.equal(writes, 0);
  throwFetch = false;
  fetchCalls = 0;

  const success = await callback.GET(request(state));
  assert.equal(success.status, 200);
  assertStateCleared(success);
  assert.equal(fetchCalls, 2);
  assert.equal(writes, 1);

  const replay = await callback.GET(request(state, "oauth-code", ""));
  assert.equal(replay.status, 400);
  assertStateCleared(replay);
  assert.equal(fetchCalls, 2);
});

test("Meta auth instructions use the stateful start endpoint", () => {
  const instructions = fsSync.readFileSync(path.join(repoRoot, "docs/meta-ads-auth-instructions.txt"), "utf8");
  assert.match(instructions, /\/api\/meta\/oauth-start/);
  assert.doesNotMatch(instructions, /dialog\/oauth\?client_id=.*oauth-callback/);
});
