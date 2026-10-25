import assert from "node:assert/strict";
import test from "node:test";
import fsSync from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

const nextServer = {
  NextRequest: class {},
  NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, json: async () => body }) },
};

function loadStageRoute({ rpcResult, enqueued }) {
  const chain = (result) => {
    const c = { select: () => c, eq: () => c, single: async () => result, maybeSingle: async () => result,
      then: (resolve) => Promise.resolve(result).then(resolve) };
    return c;
  };
  const supabase = {
    from: (table) => table === "leads"
      ? chain({ data: { id: "lead-1", assigned_to: "user-1", stage: "contacted", quality: "good" }, error: null })
      : chain({ data: [], error: null }),
    rpc: async () => ({ data: rpcResult, error: null }),
  };
  const admin = { from: () => chain({ data: { meta_leadgen_id: "123456789012345" }, error: null }) };
  return loadTypeScriptModule("src/app/api/leads/[id]/stage/route.ts", {
    "@/lib/first-contact-gate.mjs": { evaluateFirstContactGate: () => ({ allowed: true, reasons: [] }), isCompleteContact: () => true },
    "@/lib/logger": { logger: { error: () => {} }, genReqId: () => "rid" },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_c, response) => response,
      getRequestAuthContext: async () => ({ supabase, role: "sales", user: { id: "user-1" } }),
      RequestAuthError: class extends Error {},
      requestAuthErrorResponse: () => nextServer.NextResponse.json({}, { status: 401 }),
    },
    "@/shared/kanban/types": { PIPELINE_STAGES: [{ key: "contacted" }, { key: "requirement_confirmed" }] },
    "@/lib/meta-crm-events": { enqueueMetaCrmStageEvent: async (_db, lead, stage) => { enqueued.push([lead.id, stage]); return "queued"; } },
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "next/server": nextServer,
  });
}

async function patch(route, stage) {
  const request = new Request("http://localhost/api/leads/lead-1/stage", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage, note: "called", idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e" }),
  });
  return route.PATCH(request, { params: Promise.resolve({ id: "lead-1" }) });
}

test("a committed transition queues the committed stage", async () => {
  const enqueued = [];
  const route = loadStageRoute({ rpcResult: { id: "lead-1", stage: "requirement_confirmed" }, enqueued });
  assert.equal((await patch(route, "requirement_confirmed")).status, 200);
  assert.deepEqual(enqueued, [["lead-1", "requirement_confirmed"]]);
});

test("an idempotent replay of an earlier transition never queues the requested stage", async () => {
  const enqueued = [];
  const route = loadStageRoute({ rpcResult: { id: "lead-1", stage: "contacted", idempotent_replay: true }, enqueued });
  assert.equal((await patch(route, "requirement_confirmed")).status, 200);
  assert.deepEqual(enqueued, []);
});

test("a result for a different stage or lead is not reported to Meta", async () => {
  for (const rpcResult of [{ id: "lead-1", stage: "contacted" }, { id: "lead-2", stage: "requirement_confirmed" }, true]) {
    const enqueued = [];
    const route = loadStageRoute({ rpcResult, enqueued });
    assert.equal((await patch(route, "requirement_confirmed")).status, 200);
    assert.deepEqual(enqueued, [], JSON.stringify(rpcResult));
  }
});

test("workbooks without a Meta id keep their legacy import fingerprint shape", () => {
  const preview = fsSync.readFileSync(path.join(repoRoot, "src/app/api/leads/import/preview/route.ts"), "utf8");
  assert.match(preview, /\.\.\.\(norm\.leadgen_id \? \{ raw_leadgen_id: norm\.leadgen_id \} : \{\}\)/);
  assert.doesNotMatch(preview, /raw_leadgen_id: norm\.leadgen_id \|\| ""/);
});
