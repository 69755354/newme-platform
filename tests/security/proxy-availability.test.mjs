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

