// S15 D-4: the engine quotation route must not write leads.stage straight into the
// sequential-stage trigger. It advances through the audited transition_lead_stage
// routine (same path as completing the quotation milestone), or leaves the stage
// alone and says so. Either way the quotation is saved and no error is logged.
//
// This file replaces the module loader for one load, so scripts/run-node-tests.mjs
// runs it in its own process.
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

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const QUOTE_ID = "22222222-2222-4222-8222-222222222222";
const ORDER = ["new", "contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision"];

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

/** The database's sequential-stage trigger, applied to a direct stage write. */
function triggerCheck(from, to) {
  if (from === to) return null;
  if (from === "won" || from === "lost") return "Cannot change stage from terminal state";
  if (to === "won" || to === "lost") return null;
  const cur = ORDER.indexOf(from);
  const next = ORDER.indexOf(to);
  if (cur === -1 || next === -1) return "Invalid stage transition";
  return next === cur + 1 ? null : `Stage must advance sequentially. Current: ${from}, attempted: ${to}.`;
}

function makeWorld(lead) {
  const state = { stage: lead.stage, adminStageWrites: [], rpcCalls: [], logs: [] };
  const admin = {
    from(table) {
      const chain = { table, ops: [] };
      const result = () => {
        if (table === "quotations") return { data: { id: QUOTE_ID, quote_no: "NM-2026-0042" }, error: null };
        if (table === "leads" && chain.ops.some(([op]) => op === "select")) return { data: { id: LEAD_ID, customer_name: "Quote Test" }, error: null };
        if (table === "leads" && chain.ops.some(([op]) => op === "update")) {
          const patch = chain.ops.find(([op]) => op === "update")[1];
          if (patch.stage !== undefined) {
            state.adminStageWrites.push(patch.stage);
            const message = triggerCheck(state.stage, patch.stage);
            if (message) return { data: null, error: { message } };
            state.stage = patch.stage;
          }
        }
        return { data: null, error: null };
      };
      const builder = {
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
        single: async () => result(),
        maybeSingle: async () => result(),
      };
      for (const op of ["select", "insert", "update", "eq", "is", "order", "limit"]) {
        builder[op] = (...args) => { chain.ops.push([op, ...args]); return builder; };
      }
      return builder;
    },
  };
  // The signed-in user's client: reads the lead and runs the audited stage routine.
  const user = {
    from(table) {
      const rows = table === "leads"
        ? { id: LEAD_ID, stage: state.stage, final_status: lead.final_status ?? null, quality: lead.quality ?? null, next_action: lead.next_action ?? null, next_followup_date: lead.next_followup_date ?? null }
        : (lead.contacts ?? []);
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: rows, error: null }),
        maybeSingle: async () => ({ data: rows, error: null }),
        then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return builder;
    },
    async rpc(name, args) {
      state.rpcCalls.push([name, args.p_expected_stage, args.p_next_stage]);
      if (args.p_expected_stage !== state.stage) return { data: null, error: { message: "Lead was modified concurrently" } };
      const message = triggerCheck(state.stage, args.p_next_stage);
      if (message) return { data: null, error: { message } };
      state.stage = args.p_next_stage;
      return { data: { id: LEAD_ID, stage: state.stage }, error: null };
    },
  };
  const record = (level) => (...args) => state.logs.push([level, args[args.length - 1]]);
  const logger = { error: record("error"), warn: record("warn"), info: record("info"), debug: record("debug") };
  return { state, admin, user, logger };
}

const quotationRules = await import("../../src/lib/quotation-rules.mjs");
const stageAdvance = await import("../../src/lib/milestone-stage-advance.mjs");
const firstContactGate = await import("../../src/lib/first-contact-gate.mjs");

async function generate(lead) {
  const world = makeWorld(lead);
  const route = loadModule("src/app/api/quotations/generate/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
    "next/cache": { revalidatePath() {} },
    "@supabase/supabase-js": { createClient: () => world.admin },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_context, response) => response,
      getRequestAuthContext: async () => ({ role: "admin", user: { id: "actor" }, supabase: world.user }),
      RequestAuthError: class RequestAuthError extends Error {},
      requestAuthErrorResponse: (error) => ({ body: { error: error.message }, status: 401 }),
    },
    "../../../../lib/quotation-engine": {
      calculateQuotation: () => ({ subtotal: 1000, discount_rate: 0, discount_amount: 0, tax_rate: 5, tax_amount: 50, total: 1050, currency: "AED", valid_until: "2026-12-01", devices_json: [] }),
    },
    "@/lib/device-catalog": { DEVICE_CATALOG: [{ devices: [{ id: "device-1" }] }] },
    "@/lib/logger": { logger: world.logger, genReqId: () => "request-1" },
    "@/lib/quotation-labour-request": { buildBottomUpLabourRequest: () => undefined },
    "@/lib/quotation-rules.mjs": quotationRules,
    "@/lib/quotation-labour-basis.mjs": { formatInstallLabourNote: () => "" },
    "@/lib/milestone-stage-advance.mjs": stageAdvance,
    "@/lib/first-contact-gate.mjs": firstContactGate,
  });
  const testEnv = {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "test-only",
  };
  const previous = Object.fromEntries(Object.keys(testEnv).map((name) => [name, process.env[name]]));
  Object.assign(process.env, testEnv);
  try {
    const response = await route.POST({ json: async () => ({ lead_id: LEAD_ID, devices: { "device-1": 1 } }) });
    return { response, state: world.state, logs: world.state.logs };
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const noErrors = (logs) => logs.filter(([level]) => level === "error");
const READY = {
  quality: "good",
  next_action: "call back",
  next_followup_date: "2026-11-20T08:00:00Z",
  contacts: [{ contact_time: "2026-11-01T08:00:00Z", contact_result: "answered" }],
};

test("a new lead that meets the gates is advanced one audited step at a time, never by a direct stage write", async () => {
  const { response, state, logs } = await generate({ stage: "new", ...READY });
  assert.equal(response.status, 200);
  assert.equal(response.body.quote_no, "NM-2026-0042");
  assert.deepEqual(state.adminStageWrites, [], "no service-role stage write");
  assert.deepEqual(state.rpcCalls.map(([, from, to]) => `${from}>${to}`), [
    "new>contacted", "contacted>requirement_confirmed", "requirement_confirmed>solution_submitted", "solution_submitted>quotation_submitted",
  ]);
  assert.equal(state.stage, "quotation_submitted");
  assert.equal(response.body.stage_advanced, true);
  assert.equal(response.body.lead_stage, "quotation_submitted");
  assert.deepEqual(noErrors(logs), []);
});

test("a lead the first-contact gate holds back still gets its quotation, stays put, and nothing is logged as an error", async () => {
  const { response, state, logs } = await generate({ stage: "new", quality: null, contacts: [] });
  assert.equal(response.status, 200);
  assert.equal(response.body.quote_id, QUOTE_ID);
  assert.deepEqual(state.adminStageWrites, []);
  assert.equal(state.stage, "new");
  assert.equal(response.body.stage_advanced, false);
  assert.equal(response.body.stage_advance_reason, "first_contact_gate");
  assert.deepEqual(noErrors(logs), []);
  assert.ok(logs.some(([level]) => level === "info"), "recorded at info level");
});

test("a lead already past quotation_submitted (or finished) is left alone without a backwards write or an error", async () => {
  for (const [stage, final_status] of [["quotation_submitted", null], ["negotiation", null], ["pending_decision", null], ["won", "won"], ["lost", "lost"]]) {
    const { response, state, logs } = await generate({ stage, final_status, ...READY });
    assert.equal(response.status, 200, stage);
    assert.deepEqual(state.adminStageWrites, [], stage);
    assert.deepEqual(state.rpcCalls, [], stage);
    assert.equal(state.stage, stage);
    assert.deepEqual(noErrors(logs), [], stage);
    assert.equal(response.body.stage_advanced, false, stage);
  }
});

test("a lead in the stage right before quotation_submitted moves one step", async () => {
  const { response, state, logs } = await generate({ stage: "solution_submitted", ...READY });
  assert.equal(response.status, 200);
  assert.deepEqual(state.rpcCalls.map(([, from, to]) => `${from}>${to}`), ["solution_submitted>quotation_submitted"]);
  assert.equal(response.body.stage_advanced, true);
  assert.deepEqual(noErrors(logs), []);
});
