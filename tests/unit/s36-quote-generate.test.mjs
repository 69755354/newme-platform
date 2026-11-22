// S36 B3 + F10: the engine quotation route queues the Meta / WhatsApp quote feedback whenever a quotation with an amount is
// saved (not only when the stage moved), and it also accepts a hand-typed "amount only" quotation so every UI quote goes
// through the same server side effects.
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
const QUOTE_ID = "22222222-2222-4222-8222-222222222222";

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

const quotationRules = await import("../../src/lib/quotation-rules.mjs");
const stageAdvance = await import("../../src/lib/milestone-stage-advance.mjs");
const firstContactGate = await import("../../src/lib/first-contact-gate.mjs");
const quoteFeedback = await import("../../src/lib/quote-feedback.mjs");
const engine = { calculateQuotation: () => ({ subtotal: 1000, discount_rate: 0, discount_amount: 0, tax_rate: 5, tax_amount: 50, total: 1050, currency: "AED", valid_until: "2026-12-01", devices_json: [] }) };

async function post(body, { lead = { stage: "new", contacts: [] }, role = "admin" } = {}) {
  const inserted = [];
  const activities = [];
  const feedback = [];
  const admin = {
    from(table) {
      const result = () => {
        if (table === "quotations") return { data: { id: QUOTE_ID, quote_no: "NM-2026-0042" }, error: null };
        if (table === "leads") return { data: { id: LEAD_ID, customer_name: "Quote Test", stage: lead.stage, final_status: lead.final_status ?? null, archived: lead.archived ?? false }, error: null };
        return { data: null, error: null };
      };
      const builder = { then: (r, j) => Promise.resolve(result()).then(r, j), single: async () => result(), maybeSingle: async () => result() };
      for (const op of ["select", "update", "eq", "is", "order", "limit"]) builder[op] = () => builder;
      builder.insert = (row) => { if (table === "quotations") inserted.push(row); if (table === "activities") activities.push(row); return builder; };
      return builder;
    },
  };
  const user = {
    from(table) {
      const rows = table === "leads"
        ? { id: LEAD_ID, stage: lead.stage, final_status: null, quality: null, next_action: null, next_followup_date: null, assigned_to: "actor" }
        : (lead.contacts ?? []);
      const builder = { select: () => builder, eq: () => builder, single: async () => ({ data: rows, error: null }),
        maybeSingle: async () => ({ data: rows, error: null }), then: (r, j) => Promise.resolve({ data: rows, error: null }).then(r, j) };
      return builder;
    },
    async rpc() { return { data: null, error: { message: "should not be reached" } }; },
  };
  const logger = { error() {}, warn() {}, info() {}, debug() {} };
  const record = (path) => async (_db, leadId, key) => { feedback.push(`${path}:${leadId}:${key}`); return "queued"; };
  const route = loadModule("src/app/api/quotations/generate/route.ts", {
    "next/server": { NextResponse: { json: (b, init) => ({ body: b, status: init?.status ?? 200 }) } },
    "next/cache": { revalidatePath() {} },
    "@supabase/supabase-js": { createClient: () => admin },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_c, r) => r,
      getRequestAuthContext: async () => ({ role, user: { id: "actor" }, supabase: user }),
      RequestAuthError: class RequestAuthError extends Error {},
      requestAuthErrorResponse: (e) => ({ body: { error: e.message }, status: 401 }),
    },
    "../../../../lib/quotation-engine": engine,
    "@/lib/device-catalog": { DEVICE_CATALOG: [{ devices: [{ id: "device-1" }] }] },
    "@/lib/logger": { logger, genReqId: () => "request-1" },
    "@/lib/quotation-labour-request": { buildBottomUpLabourRequest: () => undefined },
    "@/lib/quotation-rules.mjs": quotationRules,
    "@/lib/quotation-labour-basis.mjs": { formatInstallLabourNote: () => "" },
    "@/lib/milestone-stage-advance.mjs": stageAdvance,
    "@/lib/first-contact-gate.mjs": firstContactGate,
    "@/lib/quote-feedback.mjs": quoteFeedback,
    "@/lib/meta-crm-events": { enqueueMetaCrmEventForLead: record("form") },
    "@/lib/website-capi-valued": { enqueueWhatsAppProgressWithDelivery: record("whatsapp"), enqueueWebsiteQuoteForProgress: record("website") },
  });
  const env = { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
  const previous = Object.fromEntries(Object.keys(env).map((n) => [n, process.env[n]]));
  Object.assign(process.env, env);
  try {
    const response = await route.POST({ json: async () => body });
    return { response, inserted, feedback, activities };
  } finally {
    for (const [n, v] of Object.entries(previous)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  }
}

const EXPECTED_FEEDBACK = [`form:${LEAD_ID}:quotation_submitted`, `whatsapp:${LEAD_ID}:quotation_submitted`, `website:${LEAD_ID}:quotation_submitted`];

test("B3: a quotation for a lead the first-contact gate holds back still queues the Meta / WhatsApp / website quote feedback", async () => {
  const { response, feedback } = await post({ lead_id: LEAD_ID, devices: { "device-1": 1 } });
  assert.equal(response.status, 200);
  assert.equal(response.body.stage_advanced, false, "the stage stays: first contact is missing");
  assert.deepEqual(feedback, EXPECTED_FEEDBACK);
});

test("B3: a lead already past quotation_submitted gets its feedback too (each queue dedupes per lead)", async () => {
  const { response, feedback } = await post({ lead_id: LEAD_ID, devices: { "device-1": 1 } }, { lead: { stage: "negotiation", contacts: [] } });
  assert.equal(response.status, 200);
  assert.deepEqual(feedback, EXPECTED_FEEDBACK);
});

test("B3: a won, lost or archived lead gets no Quoted feedback (a quote after the deal closed is not a new quoted lead)", async () => {
  for (const lead of [
    { stage: "won", final_status: "won" }, { stage: "negotiation", final_status: "won" }, { stage: "lost", final_status: "lost" },
    { stage: "won", final_status: null }, { stage: "negotiation", archived: true },
  ]) {
    const { response, feedback } = await post({ lead_id: LEAD_ID, devices: { "device-1": 1 } }, { lead: { ...lead, contacts: [] } });
    assert.equal(response.status, 200, JSON.stringify(lead));
    assert.deepEqual(feedback, [], JSON.stringify(lead));
  }
});

test("B3: an open lead is queued; a zero amount is not", async () => {
  const open = await post({ lead_id: LEAD_ID, devices: { "device-1": 1 } }, { lead: { stage: "pending_decision", contacts: [] } });
  assert.deepEqual(open.feedback, EXPECTED_FEEDBACK);
  assert.deepEqual(await quoteFeedback.enqueueQuotedFeedback({ from() { throw new Error("must not read"); } }, LEAD_ID, 0, {}), []);
});

test("F10: an amount-only quotation is computed on the server, saved, and sends the same feedback", async () => {
  const { response, inserted, feedback, activities } = await post({
    lead_id: LEAD_ID, manual: { subtotal: 20000, discount_rate: 10, tax_rate: 5, currency: "AED", payment_terms: "50% deposit" }, notes: "walk-in",
  });
  assert.equal(response.status, 200);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].subtotal, 20000);
  assert.equal(inserted[0].discount_amount, 2000);
  assert.equal(inserted[0].tax_amount, 900);
  assert.equal(inserted[0].total_amount, 18900);
  assert.equal(inserted[0].currency, "AED");
  assert.equal(inserted[0].payment_terms, "50% deposit");
  assert.equal(response.body.total, 18900);
  assert.deepEqual(feedback, EXPECTED_FEEDBACK);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].ai_generated, false, "a hand-typed quotation is not logged as AI generated");
});

test("F10: the bare 'amount only' quotation (just a number) is accepted", async () => {
  const { response, inserted } = await post({ lead_id: LEAD_ID, manual: { subtotal: 12345.678 } });
  assert.equal(response.status, 200);
  assert.equal(inserted[0].total_amount, 12345.68);
  assert.equal(inserted[0].tax_rate, 0);
  assert.equal(inserted[0].currency, "AED");
});

test("F10: an amount-only quotation with no amount, a negative figure, a huge figure or a bad discount is refused and queues nothing", async () => {
  for (const manual of [{ subtotal: 0 }, { subtotal: -5 }, { subtotal: "abc" }, { subtotal: 1e12 }, { subtotal: 100, discount_rate: 150 }, { subtotal: 100, tax_rate: -1 }, { subtotal: 100, currency: "dirham" }]) {
    const { response, inserted, feedback } = await post({ lead_id: LEAD_ID, manual });
    assert.equal(response.status, 400, JSON.stringify(manual));
    assert.deepEqual(inserted, [], JSON.stringify(manual));
    assert.deepEqual(feedback, [], JSON.stringify(manual));
  }
});
