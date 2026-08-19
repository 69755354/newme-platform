import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const QUOTE_ID = "22222222-2222-4222-8222-222222222222";
const DB_QUOTE_NO = "NM-2026-0042";
const PLACEHOLDER = "ALLOCATED_BY_DATABASE";

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
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

function calculation() {
  return {
    subtotal: 1000,
    discount_rate: 0,
    discount_amount: 0,
    tax_rate: 5,
    tax_amount: 50,
    total: 1050,
    currency: "AED",
    valid_until: "2026-09-14",
    devices_json: [{ device_id: "device-1", quantity: 1, unit_price: 1000, subtotal: 1000 }],
  };
}

/**
 * A PostgREST double that executes the complete route while recording every
 * database operation. The quotations INSERT returns a value that is deliberately
 * different from the placeholder, so a response containing DB_QUOTE_NO proves
 * the route consumed the database-returned row rather than a local generator.
 */
function adminDouble() {
  const chains = [];
  const client = {
    from(table) {
      const chain = { table, ops: [] };
      chains.push(chain);
      const builder = {
        then(resolve, reject) {
          return Promise.resolve(result()).then(resolve, reject);
        },
        single: async () => result(),
        maybeSingle: async () => result(),
      };
      for (const op of ["select", "insert", "update", "eq", "is", "order", "limit"]) {
        builder[op] = (...args) => {
          chain.ops.push([op, ...args]);
          return builder;
        };
      }
      function result() {
        if (table === "quotations") {
          return { data: { id: QUOTE_ID, quote_no: DB_QUOTE_NO }, error: null };
        }
        if (table === "leads" && chain.ops.some(([op]) => op === "select")) {
          return {
            data: {
              id: LEAD_ID,
              customer_name: "Quote Test",
              devices_json: { "device-1": 1 },
              service_needs: [],
              property_type: "villa",
              property_size_sqm: 200,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }
      return builder;
    },
  };
  return { client, chains };
}

const nextServer = {
  NextResponse: {
    json: (body, init) => ({ body, status: init?.status ?? 200 }),
  },
};
const quietLogger = { error() {}, warn() {}, info() {} };

test("quotation generate executes the insert once and propagates the database quote number", async () => {
  const { client, chains } = adminDouble();
  const route = loadModule("src/app/api/quotations/generate/route.ts", {
    "next/server": nextServer,
    "next/cache": { revalidatePath() {} },
    "@supabase/supabase-js": { createClient: () => client },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_context, response) => response,
      getRequestAuthContext: async () => ({
        role: "admin",
        user: { id: "actor" },
        supabase: {},
      }),
      RequestAuthError: class RequestAuthError extends Error {},
      requestAuthErrorResponse: (error) => ({ body: { error: error.message }, status: 401 }),
    },
    "../../../../lib/quotation-engine": { calculateQuotation: calculation },
    "@/lib/device-catalog": { DEVICE_CATALOG: [{ devices: [{ id: "device-1" }] }] },
    "@/lib/logger": { logger: quietLogger, genReqId: () => "request-1" },
    // The bottom-up labour basis is exercised by tests/unit/quotation-labour-basis.test.mjs.
    // Here it must stay inert: returning undefined makes the route keep the
    // percentage basis, so this test still observes the unmodified insert path.
    "@/lib/quotation-labour-request": { buildBottomUpLabourRequest: () => undefined },
    "@/lib/quotation-labour-basis.mjs": { formatInstallLabourNote: () => "" },
  });

  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  try {
    const response = await route.POST({
      json: async () => ({ lead_id: LEAD_ID, devices: { "device-1": 1 } }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.quote_id, QUOTE_ID);
    assert.equal(response.body.quote_no, DB_QUOTE_NO);
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }

  const quoteWrites = chains.filter((chain) => chain.table === "quotations");
  assert.equal(quoteWrites.length, 1);
  assert.equal(quoteWrites[0].ops[0][0], "insert");
  assert.equal(quoteWrites[0].ops[0][1].quote_no, PLACEHOLDER);
  assert.deepEqual(quoteWrites[0].ops.slice(1), [["select", "id, quote_no"]]);

  const activity = chains.find((chain) => chain.table === "activities");
  assert.match(activity.ops[0][1].content, new RegExp(DB_QUOTE_NO));
  const businessEvent = chains.find((chain) => chain.table === "business_events");
  assert.equal(businessEvent.ops[0][1].event_data.quote_id, QUOTE_ID);
  assert.equal(businessEvent.ops[0][1].event_data.quote_no, DB_QUOTE_NO);
});

test("Hermes generate executes the insert once and propagates the database quote number", async () => {
  const { client, chains } = adminDouble();
  const route = loadModule("src/app/api/hermes/generate-quote/route.ts", {
    "next/server": nextServer,
    "@supabase/supabase-js": { createClient: () => client },
    "@/lib/lead-auth": {
      getAuthProfile: async () => ({ userId: "actor", role: "admin" }),
      canAccessLead: async () => true,
    },
    "../../../../lib/quotation-engine": { calculateQuotation: calculation },
    "@/lib/logger": { logger: quietLogger, genReqId: () => "request-2" },
  });

  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-only";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  try {
    const response = await route.POST({
      headers: { get: () => null },
      cookies: { get: () => undefined },
      json: async () => ({ lead_id: LEAD_ID }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.quote_id, QUOTE_ID);
    assert.equal(response.body.quote_no, DB_QUOTE_NO);
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousAnon;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }

  const quoteWrites = chains.filter((chain) => chain.table === "quotations");
  assert.equal(quoteWrites.length, 1);
  assert.equal(quoteWrites[0].ops[0][0], "insert");
  assert.equal(quoteWrites[0].ops[0][1].quote_no, PLACEHOLDER);
  assert.deepEqual(quoteWrites[0].ops.slice(1), [["select", "id, quote_no"]]);
  const businessEvent = chains.find((chain) => chain.table === "business_events");
  assert.equal(businessEvent.ops[0][1].event_data.quote_no, DB_QUOTE_NO);
});

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
}

function parse(relativePath) {
  const filename = path.join(root, relativePath);
  return ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function visit(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  ts.forEachChild(node, (child) => { visit(child, predicate, found); });
  return found;
}

function quotationInsertChains(sourceFile) {
  return visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (node.expression.name.text !== "single") return false;
    const selectCall = node.expression.expression;
    if (!ts.isCallExpression(selectCall) || !ts.isPropertyAccessExpression(selectCall.expression)) return false;
    if (selectCall.expression.name.text !== "select") return false;
    if (selectCall.arguments.length !== 1 || !ts.isStringLiteral(selectCall.arguments[0])) return false;
    if (selectCall.arguments[0].text !== "id, quote_no") return false;
    const insertCall = selectCall.expression.expression;
    if (!ts.isCallExpression(insertCall) || !ts.isPropertyAccessExpression(insertCall.expression)) return false;
    if (insertCall.expression.name.text !== "insert") return false;
    const fromCall = insertCall.expression.expression;
    if (!ts.isCallExpression(fromCall) || !ts.isPropertyAccessExpression(fromCall.expression)) return false;
    return fromCall.expression.name.text === "from"
      && fromCall.arguments.length === 1
      && ts.isStringLiteral(fromCall.arguments[0])
      && fromCall.arguments[0].text === "quotations";
  });
}

const QUOTE_ENTRY_FILES = [
  "src/app/(dashboard)/quotes/quote-wizard.tsx",
  "src/app/(dashboard)/quotes/quote-calculator.tsx",
  "src/app/(dashboard)/quotes/quotes-client.tsx",
  "src/app/api/quotations/generate/route.ts",
  "src/app/api/hermes/generate-quote/route.ts",
];

test("all five quote entry points delegate allocation and select the inserted id and quote number", () => {
  for (const relativePath of QUOTE_ENTRY_FILES) {
    const sourceFile = parse(relativePath);
    const chains = quotationInsertChains(sourceFile);
    assert.equal(chains.length, 1, `${relativePath} must have exactly one insert-select-single quotation write`);

    const selectCall = chains[0].expression.expression;
    const insertCall = selectCall.expression.expression;
    const payload = insertCall.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(payload), `${relativePath} quotation payload is not an object`);
    const quoteNoProperty = payload.properties.find((property) => ts.isPropertyAssignment(property)
      && propertyName(property.name) === "quote_no");
    assert.ok(quoteNoProperty && ts.isStringLiteral(quoteNoProperty.initializer));
    assert.equal(quoteNoProperty.initializer.text, PLACEHOLDER);

    let allocationScope = chains[0];
    while (allocationScope.parent
      && !ts.isArrowFunction(allocationScope)
      && !ts.isFunctionDeclaration(allocationScope)
      && !ts.isFunctionExpression(allocationScope)) {
      allocationScope = allocationScope.parent;
    }
    const forbiddenCalls = visit(allocationScope, (node) => {
      if (!ts.isCallExpression(node)) return false;
      if (ts.isIdentifier(node.expression) && ["generateQuoteNo", "next_quote_no"].includes(node.expression.text)) return true;
      return ts.isPropertyAccessExpression(node.expression)
        && ((node.expression.expression.getText(sourceFile) === "Math" && node.expression.name.text === "random")
          || (node.expression.expression.getText(sourceFile) === "Date" && node.expression.name.text === "now"));
    });
    assert.equal(forbiddenCalls.length, 0, `${relativePath} still preallocates a quote number locally`);

    const nextQuoteRpc = visit(sourceFile, (node) => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "rpc"
      && node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === "next_quote_no"));
    assert.equal(nextQuoteRpc.length, 0, `${relativePath} still calls next_quote_no before insert`);

    const returnedFields = visit(sourceFile, (node) => ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "quote"
      && ["id", "quote_no"].includes(node.name.text));
    assert.ok(returnedFields.some((node) => node.name.text === "id"), `${relativePath} does not consume returned quote.id`);
    assert.ok(returnedFields.some((node) => node.name.text === "quote_no"), `${relativePath} does not consume returned quote.quote_no`);
  }
});
