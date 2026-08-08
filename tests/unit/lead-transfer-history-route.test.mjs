import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(filename, "utf8");
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

class MockResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.cookieWrites = [];
    this.cookies = { set: (...args) => this.cookieWrites.push(args) };
  }

  async json() {
    return this.body;
  }
}

const context = {
  refreshedCookies: [{ name: "sb-test", value: "refreshed", options: { path: "/" } }],
  role: "sales",
  supabase: {},
  user: { id: "sales-user" },
};
let authorizedResult = { status: "not_found" };

const applyPrivateNoStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  response.headers.set("Vary", "Cookie, Authorization");
  return response;
};

const route = loadTypeScriptModule("src/app/api/leads/[id]/transfer-history/route.ts", {
  "@/lib/lead-transfer-history.mjs": {
    runAuthorizedLeadTransferRead: async () => authorizedResult,
  },
  "@/lib/request-auth-context": {
    applyPrivateNoStore,
    applyRequestAuthCookies: (authContext, response) => {
      applyPrivateNoStore(response);
      for (const cookie of authContext.refreshedCookies) {
        response.cookies.set(cookie.name, cookie.value, cookie.options);
      }
      return response;
    },
    getRequestAuthContext: async () => context,
    RequestAuthError: class RequestAuthError extends Error {},
    requestAuthErrorResponse: () => new MockResponse({ error: "unauthorized" }, { status: 401 }),
  },
  "next/server": {
    NextResponse: { json: (body, init) => new MockResponse(body, init) },
  },
});

const request = new Request("https://www.newme.ae/api/leads/11111111-1111-4111-8111-111111111111/transfer-history");
const params = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };

function assertPrivateResponse(response) {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0, must-revalidate");
  assert.equal(response.headers.get("Vary"), "Cookie, Authorization");
  assert.deepEqual(response.cookieWrites, [["sb-test", "refreshed", { path: "/" }]]);
}

test("transfer history hides forbidden and missing Leads behind the same private 404", async () => {
  for (const status of ["forbidden", "not_found"]) {
    authorizedResult = { status };
    const response = await route.GET(request, params);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Lead not found" });
    assertPrivateResponse(response);
  }
});

test("transfer history returns generic private dependency errors", async () => {
  for (const [authorized, error] of [
    [{ status: "visibility_error" }, "Lead visibility check failed"],
    [{ status: "ok", value: { status: "history_error" } }, "Transfer history unavailable"],
    [{ status: "ok", value: { status: "identity_error" } }, "Transfer identities unavailable"],
  ]) {
    authorizedResult = authorized;
    const response = await route.GET(request, params);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error });
    assertPrivateResponse(response);
  }
});
