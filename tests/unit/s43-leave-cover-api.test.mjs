// S43 (B13): POST /api/team/leave-cover validates and writes through the caller's own identity (set_leave_cover).
// The loader replaces Module._load for one load, so the runner gives this file its own process.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "../..");

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain));
  try { loaded._compile(outputText, filename); return loaded.exports; } finally { Module._load = previousLoad; }
}

class RequestAuthError extends Error {}
const SALES = "00000000-0000-4000-8000-0000000000a1";
const COVER = "00000000-0000-4000-8000-0000000000a2";

function load(role, rpcResult = { data: { ok: true }, error: null }) {
  const rpcCalls = [];
  const context = { role, user: { id: "00000000-0000-4000-8000-0000000000ad" }, supabase: { rpc: async (name, args) => { rpcCalls.push([name, args]); return rpcResult; } } };
  const route = loadModule("src/app/api/team/leave-cover/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/logger": { logger: { error() {}, info() {}, warn() {} } },
    "@/lib/leave-cover.mjs": require("../../src/lib/leave-cover.mjs"),
    "@/lib/request-auth-context": {
      getRequestAuthContext: async () => context, applyRequestAuthCookies: (_c, r) => r, RequestAuthError,
      requestAuthErrorResponse: () => ({ status: 401, body: {} }),
    },
  });
  const post = (body) => route.POST(new Request("http://localhost/api/team/leave-cover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { route, post, rpcCalls };
}

test("only admin and boss may set a cover; nothing reaches the database for other roles", async () => {
  for (const role of ["sales", "operator", "finance", "designer"]) {
    const { post, rpcCalls } = load(role);
    assert.equal((await post({ userId: SALES, coverUserId: COVER, start: "2026-12-01", end: "2026-12-05" })).status, 403, role);
    assert.equal(rpcCalls.length, 0);
  }
});

test("validation: ids, self-cover, dates; a valid request calls set_leave_cover with the caller's client", async () => {
  const { post, rpcCalls } = load("admin");
  assert.equal((await post({ userId: "x", coverUserId: COVER, start: "2026-12-01", end: "2026-12-05" })).status, 400);
  assert.equal((await post({ userId: SALES, coverUserId: SALES, start: "2026-12-01", end: "2026-12-05" })).body.error, "leave_cover_self");
  assert.equal((await post({ userId: SALES, coverUserId: COVER, start: "2026-12-05", end: "2026-12-01" })).body.error, "leave_cover_dates");
  assert.equal((await post({ userId: SALES, coverUserId: COVER, start: "2026-12-01" })).body.error, "leave_cover_dates");
  assert.equal(rpcCalls.length, 0);
  const ok = await post({ userId: SALES, coverUserId: COVER, start: "2026-12-01", end: "2026-12-05" });
  assert.equal(ok.status, 200);
  assert.deepEqual(rpcCalls, [["set_leave_cover", { p_user: SALES, p_cover: COVER, p_start: "2026-12-01", p_end: "2026-12-05" }]]);
  const clear = await post({ userId: SALES, coverUserId: null });
  assert.equal(clear.status, 200);
  assert.deepEqual(rpcCalls[1], ["set_leave_cover", { p_user: SALES, p_cover: null, p_start: null, p_end: null }]);
});

test("the database refusal codes are passed on as 403 / 400", async () => {
  const denied = load("boss", { data: null, error: { code: "42501", message: "leave_cover_not_allowed" } });
  const r1 = await denied.post({ userId: SALES, coverUserId: COVER, start: "2026-12-01", end: "2026-12-05" });
  assert.equal(r1.status, 403);
  assert.equal(r1.body.error, "leave_cover_not_allowed");
  const invalid = load("boss", { data: null, error: { code: "22023", message: "leave_cover_inactive" } });
  assert.equal((await invalid.post({ userId: SALES, coverUserId: COVER, start: "2026-12-01", end: "2026-12-05" })).status, 400);
});
