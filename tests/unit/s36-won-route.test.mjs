// S36 B10 at the route: PATCH /api/leads/:id/stage to "won" needs an amount. No amount anywhere and none typed: 409 and
// the lead is untouched. A typed amount is stored before the transition and taken back out if the transition fails.
//
// This file replaces the module loader for one load, so scripts/run-node-tests.mjs runs it in its own process.
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
const KEY = "33333333-3333-4333-8333-333333333333";

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
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain));
  try { loaded._compile(outputText, filename); return loaded.exports; } finally { Module._load = previousLoad; }
}

const wonAmount = await import("../../src/lib/won-amount.mjs");
const firstContactGate = await import("../../src/lib/first-contact-gate.mjs");

async function patch(body, { quotationValue = null, quotes = [], contracts = [], rpcFails = false } = {}) {
  const state = { adminWrites: [], rpcCalls: [], lead: { quotation_value: quotationValue } };
  const admin = {
    from(table) {
      let patchBody = null;
      const q = {
        select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
        update: (p) => { patchBody = p; return q; },
        maybeSingle: async () => ({ data: table === "leads" ? { ...state.lead, meta_leadgen_id: null, final_status: "won", ctwa_clid: null } : null, error: null }),
        then: (res, rej) => {
          if (patchBody) { state.adminWrites.push([table, patchBody]); if (table === "leads") Object.assign(state.lead, patchBody); return Promise.resolve({ error: null }).then(res, rej); }
          return Promise.resolve({ data: table === "contracts" ? contracts : table === "quotations" ? quotes : [], error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  const user = {
    from(table) {
      const rows = table === "leads"
        ? { id: LEAD_ID, assigned_to: "actor", stage: "negotiation", quality: "good", quotation_value: quotationValue }
        : [{ contact_time: "2026-11-01T08:00:00Z", contact_result: "answered" }];
      const b = { select: () => b, eq: () => b, single: async () => ({ data: rows, error: null }), then: (r, j) => Promise.resolve({ data: rows, error: null }).then(r, j) };
      return b;
    },
    async rpc(name, args) {
      state.rpcCalls.push([name, args.p_next_stage]);
      return rpcFails ? { data: null, error: { message: "boom" } } : { data: { id: LEAD_ID, stage: "won" }, error: null };
    },
  };
  const route = loadModule("src/app/api/leads/[id]/stage/route.ts", {
    "next/server": { NextRequest: class {}, NextResponse: { json: (b, init) => ({ body: b, status: init?.status ?? 200 }) } },
    "@/lib/logger": { logger: { error() {} }, genReqId: () => "r1" },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_c, r) => r,
      getRequestAuthContext: async () => ({ role: "admin", user: { id: "actor" }, supabase: user }),
      RequestAuthError: class extends Error {},
      requestAuthErrorResponse: () => ({ body: {}, status: 401 }),
    },
    "@/lib/first-contact-gate.mjs": firstContactGate,
    "@/shared/kanban/types": { PIPELINE_STAGES: [{ key: "negotiation" }] },
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/meta-crm-events": { enqueueMetaCrmStageEvent: async () => "skipped" },
    "@/lib/won-amount.mjs": wonAmount,
    "@/lib/whatsapp-capi.mjs": { enqueueWhatsAppPurchaseForLead: async () => "skipped" },
    "@/lib/website-capi-valued": {
      enqueueWebsitePurchaseForLead: async () => "skipped", enqueueWebsiteQuoteForProgress: async () => "skipped", enqueueWhatsAppProgressWithDelivery: async () => "skipped",
    },
  });
  const response = await route.PATCH({ json: async () => ({ stage: "won", note: "signed", idempotencyKey: KEY, ...body }) }, { params: Promise.resolve({ id: LEAD_ID }) });
  return { response, state };
}

test("won with no contract, no quotation, no stored value and no typed amount is refused and changes nothing", async () => {
  const { response, state } = await patch({});
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "won_amount_required");
  assert.match(response.body.error_zh, /金额/);
  assert.deepEqual(state.rpcCalls, []);
  assert.deepEqual(state.adminWrites, []);
});

test("won with a typed amount stores it first, then moves the lead", async () => {
  const { response, state } = await patch({ amount: "180,000" });
  assert.equal(response.status, 200);
  assert.deepEqual(state.adminWrites, [["leads", { quotation_value: 180000 }]]);
  assert.deepEqual(state.rpcCalls, [["transition_lead_stage", "won"]]);
});

test("won uses the latest quotation or the active contract and ignores a typed amount", async () => {
  for (const world of [{ quotes: [{ total_amount: 70000, currency: "AED" }] }, { contracts: [{ contract_amount: 90000, currency: "AED" }] }, { quotationValue: 12000 }]) {
    const { response, state } = await patch({ amount: 5 }, world);
    assert.equal(response.status, 200);
    assert.deepEqual(state.adminWrites, []);
    assert.equal(state.rpcCalls.length, 1);
  }
});

test("a typed amount is taken back out when the transition fails", async () => {
  const { response, state } = await patch({ amount: 5000 }, { rpcFails: true });
  assert.equal(response.status, 400);
  assert.deepEqual(state.adminWrites, [["leads", { quotation_value: 5000 }], ["leads", { quotation_value: null }]]);
});

test("moving to a stage other than won never asks for an amount", async () => {
  const route = null; void route;
  const { response } = await patch({ stage: "negotiation" });
  assert.equal(response.status, 200);
});
