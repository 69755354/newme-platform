// S36 review P2-4: the Hermes quotation route saves a quotation with an amount, so it must queue the same Quoted
// feedback (Meta form / WhatsApp / website, same dedupe key) as the app's route, and skip it for a won / lost / archived lead.
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

const quoteFeedback = await import("../../src/lib/quote-feedback.mjs");

async function generate(lead, total = 1050) {
  const feedback = [];
  const admin = {
    from(table) {
      const result = () => {
        if (table === "quotations") return { data: { id: QUOTE_ID, quote_no: "NM-2026-0042" }, error: null };
        if (table === "leads") return { data: { id: LEAD_ID, stage: "negotiation", final_status: null, archived: false, ...lead }, error: null };
        return { data: null, error: null };
      };
      const builder = { then: (r, j) => Promise.resolve(result()).then(r, j), single: async () => result(), maybeSingle: async () => result() };
      for (const op of ["select", "insert", "update", "eq"]) builder[op] = () => builder;
      return builder;
    },
  };
  const record = (path) => async (_db, leadId, key) => { feedback.push(`${path}:${leadId}:${key}`); return "queued"; };
  const route = loadModule("src/app/api/hermes/generate-quote/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
    "@supabase/supabase-js": { createClient: () => admin },
    "@/lib/lead-auth": { getAuthProfile: async () => ({ userId: "actor", role: "admin" }), canAccessLead: async () => true },
    "../../../../lib/quotation-engine": {
      calculateQuotation: () => ({ subtotal: total, discount_rate: 0, discount_amount: 0, tax_rate: 0, tax_amount: 0, total, currency: "AED", valid_until: "2026-12-01", devices_json: [] }),
    },
    "@/lib/logger": { logger: { error() {}, warn() {}, info() {} }, genReqId: () => "request-1" },
    "@/lib/quote-feedback.mjs": quoteFeedback,
    "@/lib/meta-crm-events": { enqueueMetaCrmEventForLead: record("form") },
    "@/lib/website-capi-valued": { enqueueWhatsAppProgressWithDelivery: record("whatsapp"), enqueueWebsiteQuoteForProgress: record("website") },
  });
  const env = { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-only", SUPABASE_SERVICE_ROLE_KEY: "test-only" };
  const previous = Object.fromEntries(Object.keys(env).map((n) => [n, process.env[n]]));
  Object.assign(process.env, env);
  try {
    const response = await route.POST({ headers: { get: () => null }, cookies: { get: () => undefined }, json: async () => ({ lead_id: LEAD_ID }) });
    return { response, feedback };
  } finally {
    for (const [n, v] of Object.entries(previous)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  }
}

const EXPECTED = [`form:${LEAD_ID}:quotation_submitted`, `whatsapp:${LEAD_ID}:quotation_submitted`, `website:${LEAD_ID}:quotation_submitted`];

test("Hermes quotation with an amount queues the three Quoted feedback paths for an open lead", async () => {
  const { response, feedback } = await generate({});
  assert.equal(response.status, 200);
  assert.deepEqual(feedback, EXPECTED);
});

test("Hermes quotation queues nothing for a won, lost or archived lead, or a zero amount", async () => {
  for (const lead of [{ final_status: "won" }, { final_status: "lost" }, { stage: "won" }, { archived: true }]) {
    const { response, feedback } = await generate(lead);
    assert.equal(response.status, 200, JSON.stringify(lead));
    assert.deepEqual(feedback, [], JSON.stringify(lead));
  }
  assert.deepEqual((await generate({}, 0)).feedback, []);
});
