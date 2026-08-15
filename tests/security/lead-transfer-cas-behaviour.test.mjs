// ============================================================================
// R6 — the lead-transfer compare-and-set, executed rather than read
// ============================================================================
// The database half of R6 is measured on PG 17 by
// supabase/replay/23_lead_assignment_cas.sh: with the trigger from
// 20260817180000 dropped, a compare-and-set that should have refused succeeds
// and the audit trail lies about who held the lead; with it installed, the same
// two overlapping transactions end in CONCURRENT_LEAD_UPDATE.
//
// This file owns the application half, and it owns it by *running* the code. A
// regex over src/app/actions/settings.ts can show that the routine is named
// there; it cannot show that the token handed over is the one the caller
// compared against, that a refusal is reported instead of being swallowed, that
// two leads in one batch get different idempotency keys, or that a retry of the
// same batch gets the same ones. Those are the properties that decide whether a
// lead is silently reassigned twice, and every one of them survives a spelling
// check.
//
// Everything below is offline: the Supabase client is a double that records what
// it was asked for and answers with what the test wants to happen next.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  classifyLeadReassignResult,
  deriveLeadTransferKey,
  isLeadTransferConflict,
  isLeadUpdatedAtToken,
  readLeadTransferBatchKey,
} from "../../src/lib/lead-transfer-batch.mjs";
import {
  acquireLeadRebalanceBatchKey,
  clearLeadRebalanceBatchKey,
  LEAD_REBALANCE_PENDING_BATCH_KEY,
  leadRebalancePendingBatchStorageKey,
} from "../../src/lib/lead-rebalance-intent.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const LEAD_A = "11111111-1111-4111-8111-111111111111";
const LEAD_B = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const OTHER_BATCH = "44444444-4444-4444-8444-444444444444";
const TARGET = "55555555-5555-4555-8555-555555555555";
const TOKEN_A = "2026-08-14T04:30:53.769140+00:00";
const TOKEN_B = "2026-08-14T04:30:53.890784+00:00";

/** Compile one repository TypeScript module with `mocks` standing in for imports. */
function loadModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
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

/**
 * A PostgREST double.
 *
 * `rpc` is answered by the test's `respond` callback, which receives the call
 * count and the arguments — that is how "the first attempt succeeds and the
 * second is refused" becomes expressible. Every `from()` chain is recorded too,
 * because a direct `update({ assigned_to })` sneaking back in is the defect, and
 * the only way to say "it did not happen" is to have logged everything that did.
 */
function supabaseDouble({ respond, tables = {} } = {}) {
  const rpcCalls = [];
  const chains = [];
  const client = {
    rpc(name, args) {
      rpcCalls.push({ name, args });
      const answer = respond ? respond({ name, args, index: rpcCalls.length - 1 }) : { data: {}, error: null };
      return Promise.resolve(answer);
    },
    from(table) {
      const chain = { table, ops: [] };
      chains.push(chain);
      const builder = {
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
        single: async () => result(),
        maybeSingle: async () => result(),
      };
      const record = (op) => (...args) => {
        chain.ops.push([op, ...args]);
        return builder;
      };
      for (const op of ["select", "insert", "update", "upsert", "delete", "eq", "neq", "in", "is", "order", "limit"]) {
        builder[op] = record(op);
      }
      const result = () => {
        const answer = tables[table];
        if (typeof answer === "function") return answer(chain);
        return answer ?? { data: null, error: { message: `${table} unavailable in this test` } };
      };
      return builder;
    },
  };
  return { client, rpcCalls, chains };
}

/** The real action module, with the auth gate already passed as `role`. */
function loadSettingsActions(client, role = "admin") {
  return loadModule("src/app/actions/settings.ts", {
    "@/lib/action-auth-context": {
      getActionAuthContext: async () => ({ supabase: client, role, user: { id: "actor" }, profile: {} }),
    },
    "@/lib/lead-transfer-batch.mjs": {
      classifyLeadReassignResult,
      deriveLeadTransferKey,
      isLeadTransferConflict,
      isLeadUpdatedAtToken,
      LEAD_TRANSFER_BATCH_KEY_PATTERN:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
  });
}

// --- 1 · the derivation -----------------------------------------------------

test("R6 derived idempotency keys are stable per lead and distinct across leads", () => {
  const first = deriveLeadTransferKey(BATCH, LEAD_A);
  const second = deriveLeadTransferKey(BATCH, LEAD_B);

  // A uuid, so reassign_lead_atomic()'s uuid parameter accepts it.
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // Same pair, same key: this is what makes a retried batch replay instead of
  // transferring a second time.
  assert.equal(deriveLeadTransferKey(BATCH, LEAD_A), first);
  // Case is not a different batch.
  assert.equal(deriveLeadTransferKey(BATCH.toUpperCase(), LEAD_A.toUpperCase()), first);

  // Different lead in the same batch, and the same lead in a different batch,
  // are different operations. If either collided, one lead's recorded response
  // would be replayed for another lead's transfer.
  assert.notEqual(first, second);
  assert.notEqual(deriveLeadTransferKey(OTHER_BATCH, LEAD_A), first);

  // A malformed input is refused rather than hashed: two different malformed
  // inputs could normalise to one key, and the result would still look like a
  // valid uuid.
  assert.throws(() => deriveLeadTransferKey("not-a-uuid", LEAD_A), /uuid batch key/);
  assert.throws(() => deriveLeadTransferKey(BATCH, "not-a-uuid"), /uuid lead id/);
  assert.throws(() => deriveLeadTransferKey(BATCH, null), /uuid lead id/);
});

test("R6 the batch key must come from the caller, and a null token is not a token", () => {
  assert.equal(readLeadTransferBatchKey({ body: { batchKey: BATCH } }), BATCH);
  assert.equal(readLeadTransferBatchKey({ headerValue: BATCH.toUpperCase() }), BATCH);
  // Two different keys in one request is a client bug, not a choice to make.
  assert.equal(readLeadTransferBatchKey({ body: { batchKey: BATCH }, headerValue: OTHER_BATCH }), null);
  assert.equal(readLeadTransferBatchKey({ body: {} }), null);
  assert.equal(readLeadTransferBatchKey({ body: { batchKey: "" } }), null);
  assert.equal(readLeadTransferBatchKey({}), null);

  // p_expected_updated_at IS NULL turns the comparison off inside the routine,
  // so every absent, empty or unparseable token has to be caught before the call.
  assert.equal(isLeadUpdatedAtToken(TOKEN_A), true);
  assert.equal(isLeadUpdatedAtToken(undefined), false);
  assert.equal(isLeadUpdatedAtToken(null), false);
  assert.equal(isLeadUpdatedAtToken(""), false);
  assert.equal(isLeadUpdatedAtToken("   "), false);
  assert.equal(isLeadUpdatedAtToken("not a timestamp"), false);
  assert.equal(isLeadUpdatedAtToken(1723606253769), false);

  assert.equal(isLeadTransferConflict({ message: 'CONCURRENT_LEAD_UPDATE' }), true);
  assert.equal(isLeadTransferConflict({ message: "LEAD_NOT_FOUND" }), false);
  assert.equal(isLeadTransferConflict(null), false);

  // A replay and a no-op are not transfers. Counting either as one is how a
  // batch reports work it did not do.
  assert.equal(classifyLeadReassignResult({ unchanged: false }), "transferred");
  assert.equal(classifyLeadReassignResult({ unchanged: true }), "unchanged");
  assert.equal(classifyLeadReassignResult({ unchanged: false, idempotent_replay: true }), "replayed");
  assert.equal(classifyLeadReassignResult(null), "transferred");
});

test("R6 pending browser rebalance keys survive reload and remain scoped to their actors", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let generated = 0;
  const actorAKey = leadRebalancePendingBatchStorageKey(LEAD_A);
  const actorBKey = leadRebalancePendingBatchStorageKey(LEAD_B);
  const first = acquireLeadRebalanceBatchKey(storage, LEAD_A, () => {
    generated += 1;
    return BATCH;
  });
  const afterReload = acquireLeadRebalanceBatchKey(storage, LEAD_A, () => {
    generated += 1;
    return OTHER_BATCH;
  });
  assert.equal(first, BATCH);
  assert.equal(afterReload, BATCH);
  assert.equal(generated, 1);
  const actorB = acquireLeadRebalanceBatchKey(storage, LEAD_B, () => OTHER_BATCH);
  assert.equal(actorB, OTHER_BATCH);
  assert.equal(values.get(actorAKey), BATCH);
  assert.equal(values.get(actorBKey), OTHER_BATCH);
  assert.equal(clearLeadRebalanceBatchKey(storage, LEAD_B, OTHER_BATCH), true);
  assert.equal(values.get(actorAKey), BATCH, "actor B cleared actor A's pending intent");
  assert.equal(acquireLeadRebalanceBatchKey(storage, LEAD_A, () => OTHER_BATCH), BATCH);
  assert.equal(clearLeadRebalanceBatchKey(storage, LEAD_A, OTHER_BATCH), false);
  assert.equal(values.get(actorAKey), BATCH);
  assert.equal(clearLeadRebalanceBatchKey(storage, LEAD_A, BATCH), true);
  assert.equal(values.has(actorAKey), false);
  assert.equal(LEAD_REBALANCE_PENDING_BATCH_KEY, "newme:lead-rebalance:pending-batch-v1");
});

test("R6 storage failure refuses to mint an ephemeral rebalance intent", () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };
  assert.throws(() => acquireLeadRebalanceBatchKey(storage, LEAD_A, () => BATCH), /quota/);
  assert.throws(() => acquireLeadRebalanceBatchKey(storage, "not-an-actor", () => BATCH), /actor id/);
});

// --- 2 · the actions --------------------------------------------------------

test("R6 assignLead sends the caller's token and the derived key to the routine", async () => {
  const { client, rpcCalls, chains } = supabaseDouble({
    respond: () => ({ data: { lead_id: LEAD_A, assigned_to: TARGET, unchanged: false, updated_at: TOKEN_B }, error: null }),
  });
  const actions = loadSettingsActions(client);

  const report = await actions.assignLead(LEAD_A, TARGET, TOKEN_A, BATCH);

  assert.deepEqual(rpcCalls, [{
    name: "reassign_lead_atomic",
    args: {
      p_lead_id: LEAD_A,
      p_new_assignee: TARGET,
      p_expected_updated_at: TOKEN_A,
      p_idempotency_key: deriveLeadTransferKey(BATCH, LEAD_A),
      p_reason: "settings_assign",
    },
  }]);
  // The owner write went through the routine and nowhere else.
  assert.deepEqual(chains, []);
  assert.deepEqual(report.transferred, [{ id: LEAD_A, updatedAt: TOKEN_B }]);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.failed, []);
});

test("R6 a refused transfer is reported as a conflict and never counted as transferred", async () => {
  const { client, rpcCalls } = supabaseDouble({
    // What PostgREST hands back when the routine raises P0001.
    respond: () => ({ data: null, error: { message: 'CONCURRENT_LEAD_UPDATE', code: "P0001" } }),
  });
  const actions = loadSettingsActions(client);

  const report = await actions.assignLead(LEAD_A, TARGET, TOKEN_A, BATCH);

  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(report.transferred, []);
  assert.deepEqual(report.conflicts, [LEAD_A]);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.replayed, []);
});

test("R6 a bulk assign keys each lead separately and survives a mixed outcome", async () => {
  const answers = {
    [LEAD_A]: { data: { lead_id: LEAD_A, assigned_to: TARGET, unchanged: false, updated_at: TOKEN_B }, error: null },
    [LEAD_B]: { data: null, error: { message: 'CONCURRENT_LEAD_UPDATE' } },
  };
  const { client, rpcCalls } = supabaseDouble({ respond: ({ args }) => answers[args.p_lead_id] });
  const actions = loadSettingsActions(client);

  const report = await actions.bulkAssignLeads(
    [{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }, { id: LEAD_B, expectedUpdatedAt: TOKEN_B }],
    TARGET,
    BATCH,
  );

  // One call per lead — an `in` clause cannot produce transfer_history's
  // from_user_id, which is why the 50-per-batch update is gone.
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[0].args.p_expected_updated_at, TOKEN_A);
  assert.equal(rpcCalls[1].args.p_expected_updated_at, TOKEN_B);
  assert.notEqual(rpcCalls[0].args.p_idempotency_key, rpcCalls[1].args.p_idempotency_key);

  // One moved, one refused. The refusal does not stop the batch and does not
  // pretend the lead moved.
  assert.deepEqual(report.transferred, [{ id: LEAD_A, updatedAt: TOKEN_B }]);
  assert.deepEqual(report.conflicts, [LEAD_B]);
});

test("R6 re-running the same batch replays the leads that already moved", async () => {
  const seen = new Set();
  const respond = ({ args }) => (seen.has(args.p_idempotency_key)
    // The routine's own answer for a spent key: the recorded response plus the flag.
    ? { data: { lead_id: args.p_lead_id, assigned_to: TARGET, unchanged: false, idempotent_replay: true }, error: null }
    : (seen.add(args.p_idempotency_key),
      { data: { lead_id: args.p_lead_id, assigned_to: TARGET, unchanged: false, updated_at: TOKEN_B }, error: null }));

  const { client } = supabaseDouble({ respond });
  const actions = loadSettingsActions(client);
  const targets = [{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }];

  const first = await actions.bulkAssignLeads(targets, TARGET, BATCH);
  assert.deepEqual(first.transferred.map((l) => l.id), [LEAD_A]);
  assert.deepEqual(first.replayed, []);

  // Same batch key, same lead: replayed, not transferred again.
  const second = await actions.bulkAssignLeads(targets, TARGET, BATCH);
  assert.deepEqual(second.transferred, []);
  assert.deepEqual(second.replayed, [LEAD_A]);

  // A different batch key is a different decision and is carried out.
  const third = await actions.bulkAssignLeads(targets, TARGET, OTHER_BATCH);
  assert.deepEqual(third.transferred.map((l) => l.id), [LEAD_A]);
});

test("R6 an action refuses to call the routine without a token or a batch key", async () => {
  const { client, rpcCalls } = supabaseDouble({ respond: () => ({ data: {}, error: null }) });
  const actions = loadSettingsActions(client);

  const report = await actions.bulkAssignLeads([{ id: LEAD_A, expectedUpdatedAt: null }], TARGET, BATCH);
  assert.deepEqual(rpcCalls, [], "a lead with no token reached the routine, where null means do not compare");
  assert.deepEqual(report.failed, [{ id: LEAD_A, message: "missing expectedUpdatedAt" }]);

  await assert.rejects(
    () => actions.bulkAssignLeads([{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }], TARGET, "not-a-uuid"),
    /batchKey must be a UUID/,
  );
  assert.deepEqual(rpcCalls, [], "a batch with no key reached the routine");

  // And the role gate still comes first, before either check.
  const asSales = loadSettingsActions(client, "sales");
  await assert.rejects(() => asSales.assignLead(LEAD_A, TARGET, TOKEN_A, BATCH), /Forbidden/);
  await assert.rejects(() => asSales.bulkUnassignLeads([{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }]), /Forbidden/);
});

test("R6 bulkUnassignLeads sends the caller token and a stable per-lead key to the audited routine", async () => {
  const answers = {
    [LEAD_A]: {
      data: { lead_id: LEAD_A, assigned_to: null, unchanged: false, updated_at: TOKEN_B },
      error: null,
    },
    [LEAD_B]: { data: null, error: { message: "CONCURRENT_LEAD_UPDATE", code: "P0001" } },
  };
  const { client, rpcCalls, chains } = supabaseDouble({
    respond: ({ args }) => answers[args.p_lead_id],
  });
  const actions = loadSettingsActions(client);

  const report = await actions.bulkUnassignLeads(
    [{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }, { id: LEAD_B, expectedUpdatedAt: TOKEN_B }],
    BATCH,
  );

  assert.deepEqual(rpcCalls, [
    {
      name: "unassign_lead_atomic",
      args: {
        p_lead_id: LEAD_A,
        p_expected_updated_at: TOKEN_A,
        p_idempotency_key: deriveLeadTransferKey(BATCH, LEAD_A),
        p_reason: "settings_bulk_unassign",
      },
    },
    {
      name: "unassign_lead_atomic",
      args: {
        p_lead_id: LEAD_B,
        p_expected_updated_at: TOKEN_B,
        p_idempotency_key: deriveLeadTransferKey(BATCH, LEAD_B),
        p_reason: "settings_bulk_unassign",
      },
    },
  ]);
  assert.notEqual(rpcCalls[0].args.p_idempotency_key, rpcCalls[1].args.p_idempotency_key);
  assert.deepEqual(chains, [], "bulk unassign bypassed the audited routine with a direct table write");
  assert.deepEqual(report.transferred, [{ id: LEAD_A, updatedAt: TOKEN_B }]);
  assert.deepEqual(report.conflicts, [LEAD_B]);
  assert.deepEqual(report.failed, []);
});

test("R6 bulkUnassignLeads classifies routine replay and unchanged results without counting writes", async () => {
  const seen = new Set();
  const { client, rpcCalls } = supabaseDouble({
    respond: ({ args }) => {
      if (seen.has(args.p_idempotency_key)) {
        return {
          data: { lead_id: args.p_lead_id, assigned_to: null, unchanged: false, idempotent_replay: true },
          error: null,
        };
      }
      seen.add(args.p_idempotency_key);
      return { data: { lead_id: args.p_lead_id, assigned_to: null, unchanged: true }, error: null };
    },
  });
  const actions = loadSettingsActions(client);
  const targets = [{ id: LEAD_A, expectedUpdatedAt: TOKEN_A }];

  const first = await actions.bulkUnassignLeads(targets, BATCH);
  assert.deepEqual(first.unchanged, [LEAD_A]);
  assert.deepEqual(first.transferred, []);
  assert.deepEqual(first.replayed, []);

  const replay = await actions.bulkUnassignLeads(targets, BATCH);
  assert.deepEqual(replay.replayed, [LEAD_A]);
  assert.deepEqual(replay.transferred, []);

  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[0].args.p_idempotency_key, rpcCalls[1].args.p_idempotency_key);

  const missingToken = await actions.bulkUnassignLeads(
    [{ id: LEAD_B, expectedUpdatedAt: null }],
    BATCH,
  );
  assert.deepEqual(missingToken.failed, [{ id: LEAD_B, message: "missing expectedUpdatedAt" }]);
  assert.equal(rpcCalls.length, 2, "a null compare-and-set token reached unassign_lead_atomic");

  await assert.rejects(() => actions.bulkUnassignLeads(targets, "not-a-uuid"), /batchKey must be a UUID/);
  assert.equal(rpcCalls.length, 2, "an invalid idempotency batch key reached unassign_lead_atomic");
});

// --- 3 · the rebalance route ------------------------------------------------

/**
 * The rebalance route with its framework and its client replaced.
 *
 * `next/server` is reduced to what the route uses: a request whose json() and
 * headers are the test's, and a NextResponse.json that hands back the object it
 * was given so the assertions can read the body and the status.
 */
function loadRebalanceRoute(client) {
  return loadModule("src/app/api/dashboard/sales-load/rebalance/route.ts", {
    "next/server": {
      NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
    },
    "@/lib/supabase-server": { createServerSupabase: async () => client },
    "@/lib/lead-transfer-candidates.mjs": {
      filterLeadTransferCandidateQuery: (query) => query,
    },
    "@/lib/lead-transfer-batch.mjs": {
      classifyLeadReassignResult,
      deriveLeadTransferKey,
      isLeadTransferConflict,
      readLeadTransferBatchKey,
    },
  });
}

function rebalanceRequest(body) {
  return {
    headers: { get: () => null },
    json: async () => body,
  };
}

/**
 * A double shaped for the rebalance route's four reads.
 *
 * `leads` is asked for twice — once for the per-rep counts and once for the
 * transferable rows — so it answers by looking at what the chain filtered on.
 */
function rebalanceClient({ reps, counts, transferable, respond, persistedPlan = null }) {
  let storedPlan = persistedPlan;
  const { client, rpcCalls, chains } = supabaseDouble({
    respond: (call) => {
      if (call.name === "get_or_create_lead_rebalance_plan") {
        if (storedPlan !== null) {
          return { data: { found: true, plan: structuredClone(storedPlan) }, error: null };
        }
        if (call.args.p_plan === undefined) {
          return { data: { found: false }, error: null };
        }
        storedPlan = structuredClone(call.args.p_plan);
        return { data: { found: true, plan: structuredClone(storedPlan) }, error: null };
      }
      return respond
        ? respond(call)
        : { data: { unchanged: false }, error: null };
    },
    tables: {
      profiles: (chain) => (chain.ops.some(([op, column]) => op === "eq" && column === "id")
        ? { data: { role: "admin" }, error: null }
        : { data: typeof reps === "function" ? reps() : reps, error: null }),
      leads: (chain) => (chain.ops.some(([op, column]) => op === "eq" && column === "stage")
        ? { data: typeof transferable === "function" ? transferable() : transferable, error: null }
        : { data: typeof counts === "function" ? counts() : counts, error: null }),
    },
  });
  client.auth = { getUser: async () => ({ data: { user: { id: "actor" } }, error: null }) };
  return { client, rpcCalls, chains, getStoredPlan: () => structuredClone(storedPlan) };
}

const REPS = [
  { id: "over", full_name: "Overloaded", email: "over@newme.ae", role: "sales", is_active: true },
  { id: "under", full_name: "Underloaded", email: "under@newme.ae", role: "sales", is_active: true },
];
// Four leads on one rep and none on the other: avg 2, threshold 3, so "over" is
// overloaded and "under" is underloaded and the route has work to do.
const COUNTS = [
  { assigned_to: "over" }, { assigned_to: "over" }, { assigned_to: "over" }, { assigned_to: "over" },
];

test("R6 the rebalance route refuses a request that cannot be retried", async () => {
  const { client, rpcCalls } = rebalanceClient({ reps: REPS, counts: COUNTS, transferable: [] });
  const route = loadRebalanceRoute(client);

  const answer = await route.POST(rebalanceRequest({}));
  assert.equal(answer.status, 400);
  assert.equal(answer.body.code, "INVALID_REQUEST");
  assert.deepEqual(rpcCalls, [], "the route read leads before deciding it had no batch key");
});

test("R6 the rebalance route transfers through the routine and reports refusals apart", async () => {
  const transferable = [
    { id: LEAD_A, assigned_to: "over", customer_name: "A", updated_at: TOKEN_A },
    { id: LEAD_B, assigned_to: "over", customer_name: "B", updated_at: TOKEN_B },
  ];
  const answers = {
    [LEAD_A]: { data: { lead_id: LEAD_A, assigned_to: "under", unchanged: false }, error: null },
    [LEAD_B]: { data: null, error: { message: 'CONCURRENT_LEAD_UPDATE' } },
  };
  const { client, rpcCalls, chains } = rebalanceClient({
    reps: REPS,
    counts: COUNTS,
    transferable,
    respond: ({ args }) => answers[args.p_lead_id],
  });
  const route = loadRebalanceRoute(client);

  const answer = await route.POST(rebalanceRequest({ batchKey: BATCH }));

  // The token came from the same read as the plan, and each lead got its own key.
  const planCalls = rpcCalls.filter((call) => call.name === "get_or_create_lead_rebalance_plan");
  const transferCalls = rpcCalls.filter((call) => call.name === "reassign_lead_atomic");
  assert.equal(planCalls.length, 2);
  assert.equal(planCalls[0].args.p_plan, undefined);
  assert.equal(transferCalls.length, 2);
  assert.equal(transferCalls[0].args.p_expected_updated_at, TOKEN_A);
  assert.equal(transferCalls[1].args.p_expected_updated_at, TOKEN_B);
  assert.equal(transferCalls[0].args.p_idempotency_key, deriveLeadTransferKey(BATCH, LEAD_A));
  assert.equal(planCalls[1].args.p_plan.updates[0].idempotency_key, transferCalls[0].args.p_idempotency_key);
  assert.equal(transferCalls[0].args.p_reason, "sales_load_rebalance");

  // Not one direct owner write. This is the assertion the old route failed.
  const ownerWrites = chains.filter((chain) => chain.ops.some(
    ([op, payload]) => op === "update" && payload && Object.hasOwn(payload, "assigned_to"),
  ));
  assert.deepEqual(ownerWrites, []);

  // One moved, one refused: 200, and the refusal is in the body rather than in
  // the transferred count.
  assert.equal(answer.status, 200);
  assert.equal(answer.body.transferred, 1);
  assert.equal(answer.body.conflicts, 1);
  assert.equal(answer.body.replayed, 0);
  assert.match(answer.body.message, /1 skipped because they were reassigned/);
});

test("R6 a replayed rebalance reports zero transferred rather than repeating itself", async () => {
  const transferable = [{ id: LEAD_A, assigned_to: "over", customer_name: "A", updated_at: TOKEN_A }];
  const { client } = rebalanceClient({
    reps: REPS,
    counts: COUNTS,
    transferable,
    respond: () => ({
      data: { lead_id: LEAD_A, assigned_to: "under", unchanged: false, idempotent_replay: true },
      error: null,
    }),
  });
  const route = loadRebalanceRoute(client);

  const answer = await route.POST(rebalanceRequest({ batchKey: BATCH }));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.transferred, 0);
  assert.equal(answer.body.replayed, 1);
});

test("R6 a partial rebalance retry executes the original stored plan without replanning", async () => {
  const transferable = [
    { id: LEAD_A, assigned_to: "over", customer_name: "A", updated_at: TOKEN_A },
    { id: LEAD_B, assigned_to: "over", customer_name: "B", updated_at: TOKEN_B },
  ];
  let currentCounts = COUNTS;
  const attempts = new Map();
  const { client, rpcCalls, chains, getStoredPlan } = rebalanceClient({
    reps: REPS,
    counts: () => currentCounts,
    transferable,
    respond: ({ args }) => {
      const attempt = attempts.get(args.p_lead_id) ?? 0;
      attempts.set(args.p_lead_id, attempt + 1);
      if (args.p_lead_id === LEAD_B && attempt === 0) {
        return { data: null, error: { message: "temporary transport failure" } };
      }
      return {
        data: {
          lead_id: args.p_lead_id,
          assigned_to: args.p_new_assignee,
          unchanged: false,
          idempotent_replay: args.p_lead_id === LEAD_A && attempt > 0,
        },
        error: null,
      };
    },
  });
  const route = loadRebalanceRoute(client);

  const first = await route.POST(rebalanceRequest({ batchKey: BATCH }));
  assert.equal(first.status, 500);
  assert.equal(first.body.transferred, 1);
  assert.equal(first.body.failed, 1);
  const storedPlan = getStoredPlan();
  const firstLeadReads = chains.filter((chain) => chain.table === "leads").length;

  // One successful transfer changes the live distribution enough for the old
  // implementation to return its early "No imbalance" response. A retry must
  // still replay A and finish B from the stored first-attempt plan.
  currentCounts = [
    { assigned_to: "over" }, { assigned_to: "over" }, { assigned_to: "over" }, { assigned_to: "under" },
  ];
  const second = await route.POST(rebalanceRequest({ batchKey: BATCH }));
  assert.equal(second.status, 200);
  assert.equal(second.body.transferred, 1);
  assert.equal(second.body.replayed, 1);
  assert.equal(second.body.conflicts, 0);
  assert.equal(chains.filter((chain) => chain.table === "leads").length, firstLeadReads);

  const transferCalls = rpcCalls.filter((call) => call.name === "reassign_lead_atomic");
  assert.equal(transferCalls.length, 4);
  for (const leadId of [LEAD_A, LEAD_B]) {
    const calls = transferCalls.filter((call) => call.args.p_lead_id === leadId);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.p_new_assignee, calls[1].args.p_new_assignee);
    assert.equal(calls[0].args.p_idempotency_key, calls[1].args.p_idempotency_key);
    assert.equal(
      storedPlan.updates.find((update) => update.id === leadId).idempotency_key,
      calls[0].args.p_idempotency_key,
    );
  }
});

test("R6 the rebalance route treats a lead with no token as a failure, not as a free transfer", async () => {
  const transferable = [{ id: LEAD_A, assigned_to: "over", customer_name: "A", updated_at: null }];
  const { client, rpcCalls } = rebalanceClient({
    reps: REPS,
    counts: COUNTS,
    transferable,
    respond: () => ({ data: { unchanged: false }, error: null }),
  });
  const route = loadRebalanceRoute(client);

  const answer = await route.POST(rebalanceRequest({ batchKey: BATCH }));
  assert.equal(
    rpcCalls.filter((call) => call.name === "reassign_lead_atomic").length,
    0,
    "a lead with no token was sent to the routine, where null means do not compare",
  );
  assert.equal(answer.status, 500);
  assert.equal(answer.body.failed, 1);
  assert.equal(answer.body.transferred, 0);
});

test("R6 transferAllLeads enumerates the owner's leads and tokens each one", async () => {
  const { client, rpcCalls, chains } = supabaseDouble({
    tables: {
      leads: () => ({ data: [{ id: LEAD_A, updated_at: TOKEN_A }, { id: LEAD_B, updated_at: TOKEN_B }], error: null }),
    },
    respond: ({ args }) => ({
      data: { lead_id: args.p_lead_id, assigned_to: TARGET, unchanged: false, updated_at: TOKEN_B },
      error: null,
    }),
  });
  const actions = loadSettingsActions(client);

  const report = await actions.transferAllLeads("from-user", TARGET, BATCH);

  // "All of A's leads" is resolved against the database, not against a screen.
  assert.deepEqual(chains.length, 1);
  assert.deepEqual(chains[0].ops, [
    ["select", "id, updated_at"],
    ["eq", "assigned_to", "from-user"],
  ]);
  assert.deepEqual(rpcCalls.map((call) => call.args.p_lead_id), [LEAD_A, LEAD_B]);
  assert.deepEqual(rpcCalls.map((call) => call.args.p_expected_updated_at), [TOKEN_A, TOKEN_B]);
  assert.equal(report.transferred.length, 2);
});
