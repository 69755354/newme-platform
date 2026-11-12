// S16 (NEXT-DB-BATCH, application items from the Opus review of S12 round 2):
//  * a contract resubmitted after a rejection has no pending approval row, so the
//    "pending approval" notification could not be built (it keys on that row) and was
//    only logged. The PATCH route now opens the row first and then sends the notification.
//  * when the first approval step passes, the boss step is open; nobody was told.
//    The approve route now sends contract_pending_approval for the pending_ceo contract.
//
// This file replaces the module loader for each load, so scripts/run-node-tests.mjs runs
// it in its own process.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const CONTRACT = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request)
    ? mocks[request]
    : previousLoad.call(Module, request, parent, isMain));
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

const moneyRpc = await import("../../src/lib/money-rpc.mjs");
const capabilities = await import("../../src/lib/contract-status-capabilities.mjs");
const actionPermissions = await import("../../src/lib/contract-action-permissions.mjs");
const approvalRows = await import("../../src/lib/contract-approval-rows.mjs");

/** An admin client over contract_approvals only. */
function fakeAdmin(rows, { failInsert = false } = {}) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      assert.equal(table, "contract_approvals");
      const filters = {};
      const builder = {
        select: () => builder,
        eq: (field, value) => { filters[field] = value; return builder; },
        limit: () => builder,
        maybeSingle: async () => ({
          data: rows.find((row) => Object.entries(filters).every(([field, value]) => row[field] === value)) ?? null,
          error: null,
        }),
        insert: async (row) => {
          if (failInsert) return { error: { message: "insert refused" } };
          inserts.push(row);
          rows.push({ id: `row-${rows.length + 1}`, ...row });
          return { error: null };
        },
      };
      return builder;
    },
  };
}

function patchWorld({ approvals, failInsert = false, dispatchFails = false }) {
  const admin = fakeAdmin(approvals, { failInsert });
  const events = [];
  const logs = [];
  const record = (level) => (...args) => logs.push([level, args[args.length - 1]]);
  const user = {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    rpc: async (name, args) => {
      events.push(["rpc", name, args.p_status]);
      return { data: { success: true, status: args.p_status }, error: null };
    },
  };
  const route = loadModule("src/app/api/contracts/[id]/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
    "next/cache": { revalidatePath() {} },
    "@/lib/supabase-server": { createServerSupabase: async () => user },
    "@/lib/request-auth-context": { applyPrivateNoStore: (response) => response },
    "@/lib/logger": { logger: { error: record("error"), warn: record("warn"), info: record("info") }, genReqId: () => "request-1" },
    "@/lib/money-rpc.mjs": moneyRpc,
    "@/lib/contract-status-capabilities.mjs": capabilities,
    "@/lib/contract-action-permissions.mjs": actionPermissions,
    "@/lib/contract-approval-rows.mjs": approvalRows,
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/meta-crm-events": { enqueueMetaCrmWonForContract: async () => {} },
    "@/lib/notification-dispatch": {
      dispatchPersistedNotification: async ({ input }) => {
        events.push(["notify", input.type, approvals.filter((row) => row.status === "pending").length]);
        if (dispatchFails) throw new Error("dispatch failed");
        return { created: 1, skipped: 0 };
      },
    },
  });
  return { route, admin, events, logs };
}

const patch = (route, status) => route.PATCH(
  { headers: { get: () => null }, json: async () => ({ status }) },
  { params: Promise.resolve({ id: CONTRACT }) },
);

test("resubmitting a rejected contract opens a pending admin_review row, then sends the pending-approval notification", async () => {
  const approvals = [{ id: "a1", contract_id: CONTRACT, step: "admin_review", status: "rejected" }];
  const world = patchWorld({ approvals });
  const response = await patch(world.route, "pending_admin");
  assert.equal(response.status, 200);
  assert.equal(world.admin.inserts.length, 1);
  assert.deepEqual(world.admin.inserts[0], {
    contract_id: CONTRACT, step: "admin_review", status: "pending", notes: { source: "resubmit" },
  });
  // the row exists before the notification is built (the event keys on it)
  assert.deepEqual(world.events.map((event) => event.slice(0, 2).join(":")), ["rpc:set_contract_status", "notify:contract_pending_approval"]);
  assert.equal(world.events[1][2], 1);
  assert.deepEqual(world.logs.filter(([level]) => level === "warn" || level === "error"), []);
});

test("a contract that already has its pending admin_review row gets no second row", async () => {
  const approvals = [{ id: "a1", contract_id: CONTRACT, step: "admin_review", status: "pending" }];
  const world = patchWorld({ approvals });
  await patch(world.route, "pending_admin");
  assert.equal(world.admin.inserts.length, 0);
  assert.equal(approvals.length, 1);
  assert.equal(world.events.at(-1)[1], "contract_pending_approval");
});

test("only the move to pending_admin opens a row", async () => {
  for (const status of ["draft", "suspended"]) {
    const approvals = [];
    const world = patchWorld({ approvals });
    await patch(world.route, status);
    assert.equal(world.admin.inserts.length, 0, status);
    assert.equal(world.events.some((event) => event[0] === "notify"), false, status);
  }
});

test("a failed row insert or a failed notification never fails the status change", async () => {
  for (const options of [{ failInsert: true }, { dispatchFails: true }]) {
    const world = patchWorld({ approvals: [], ...options });
    const response = await patch(world.route, "pending_admin");
    assert.equal(response.status, 200);
    assert.ok(world.logs.some(([level]) => level === "warn"));
    assert.equal(world.logs.some(([level]) => level === "error"), false);
  }
});

function approveWorld(rpcResult) {
  const events = [];
  const logs = [];
  const record = (level) => (...args) => logs.push([level, args[args.length - 1]]);
  const user = {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: "admin" }, error: null }) }) }) }),
    rpc: async (name, args) => {
      events.push(["rpc", name, args.p_action]);
      return { data: rpcResult, error: null };
    },
  };
  const route = loadModule("src/app/api/contracts/[id]/approve/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase-server": { createServerSupabase: async () => user },
    "@/lib/logger": { logger: { error: record("error"), warn: record("warn"), info: record("info") }, genReqId: () => "request-1" },
    "@/lib/money-rpc.mjs": moneyRpc,
    "@/lib/contract-action-permissions.mjs": actionPermissions,
    "@/lib/notification-dispatch": {
      dispatchPersistedNotification: async ({ input }) => {
        events.push(["notify", input.type, input.contract_id]);
        return { created: 1, skipped: 0 };
      },
    },
  });
  return { route, events, logs };
}

const approve = (route, action) => route.POST(
  { headers: { get: () => null }, json: async () => ({ action, notes: "ok" }) },
  { params: Promise.resolve({ id: CONTRACT }) },
);

test("passing the first approval step tells the boss step is open", async () => {
  const world = approveWorld({ success: true, action: "approved", new_status: "pending_ceo", step: "admin_review" });
  const response = await approve(world.route, "approve");
  assert.equal(response.status, 200);
  assert.deepEqual(world.events.filter((event) => event[0] === "notify").map((event) => event[1]), [
    "contract_approved", "contract_pending_approval",
  ]);
  assert.deepEqual(world.logs.filter(([level]) => level === "warn" || level === "error"), []);
});

test("the final approval and a rejection do not announce a further step", async () => {
  for (const [action, result] of [
    ["approve", { success: true, action: "approved", new_status: "approved", step: "ceo_review" }],
    ["reject", { success: true, action: "rejected", new_status: "rejected", step: "admin_review" }],
  ]) {
    const world = approveWorld(result);
    await approve(world.route, action);
    assert.deepEqual(world.events.filter((event) => event[0] === "notify").map((event) => event[1]),
      [action === "approve" ? "contract_approved" : "contract_rejected"], action);
  }
});

test("ensurePendingApproval is a no-op when a pending row exists and reports an insert failure without throwing", async () => {
  const rows = [{ id: "r", contract_id: CONTRACT, step: "ceo_review", status: "pending" }];
  assert.deepEqual(await approvalRows.ensurePendingApproval(fakeAdmin(rows), { contractId: CONTRACT, step: "ceo_review", source: "x" }), { created: false });
  const failed = await approvalRows.ensurePendingApproval(fakeAdmin([], { failInsert: true }), { contractId: CONTRACT, step: "admin_review", source: "x" });
  assert.equal(failed.created, false);
  assert.ok(failed.error);
});
