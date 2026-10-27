import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) =>
    Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain);
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

const nextServer = {
  NextResponse: {
    json: (body, init) => ({ body, status: init?.status ?? 200 }),
  },
};

function request() {
  return new Request("https://app.newme.ae/api/kpi/targets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      period: "2026-08",
      targets: [{ target_type: "revenue", target_amount: 100, assigned_to: null }],
    }),
  });
}

function loadPost(role) {
  const rpcCalls = [];
  const profileQuery = {
    select: () => profileQuery,
    eq: () => profileQuery,
    single: async () => ({ data: { role }, error: null }),
  };
  const callerClient = {
    auth: { getUser: async () => ({ data: { user: { id: "caller-1" } }, error: null }) },
    from: (table) => {
      assert.equal(table, "profiles", "the role decision must read the caller profile");
      return profileQuery;
    },
  };
  const adminClient = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return { data: [{ id: "target-1" }], error: null };
    },
  };
  const route = loadTypeScriptModule("src/app/api/kpi/targets/route.ts", {
    "next/server": nextServer,
    "@/lib/supabase-server": { createServerSupabase: async () => callerClient },
    "@/lib/supabase-admin": { supabaseAdmin: adminClient },
    "@/lib/request-auth-context": { applyPrivateNoStore: (response) => response },
    "@/lib/money-rpc.mjs": { moneyRpcFailure: () => ({ status: 500, body: { error: "unexpected" } }) },
  });
  return { post: route.POST, rpcCalls };
}

for (const role of ["admin", "boss"]) {
  test(`KPI POST allows ${role} and invokes replace_kpi_targets exactly once`, async () => {
    const { post, rpcCalls } = loadPost(role);
    const response = await post(request());

    assert.equal(response.status, 200);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].name, "replace_kpi_targets");
    assert.deepEqual(rpcCalls[0].args, {
      p_period: "2026-08",
      p_rows: [{ target_type: "revenue", target_amount: 100, assigned_to: null, notes: null }],
      p_set_by: "caller-1",
    });
  });
}

for (const role of ["operator", "sales", "finance", "designer"]) {
  test(`KPI POST refuses ${role} before the service-role RPC`, async () => {
    const { post, rpcCalls } = loadPost(role);
    const response = await post(request());

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "Forbidden" });
    assert.equal(rpcCalls.length, 0);
  });
}
