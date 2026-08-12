import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as paymentBoundary from "../../src/lib/payment-idempotency.mjs";
import * as paymentServer from "../../src/lib/payment-idempotency-server.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
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

class MockResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
  }
  async json() {
    return this.body;
  }
}

const nextServer = { NextResponse: { json: (body, init) => new MockResponse(body, init) } };
const logger = { info() {}, warn() {}, error() {} };

function createState({ role = "finance", userId = "user-1" } = {}) {
  return {
    user: { id: userId },
    role,
    contracts: [
      {
        id: "contract-own",
        contract_no: "C-OWN",
        contract_amount: 1000,
        status: "active",
        party_a_name: "Owned customer",
        sales_id: userId,
      },
      {
        id: "contract-other",
        contract_no: "C-OTHER",
        contract_amount: 1000,
        status: "active",
        party_a_name: "Other customer",
        sales_id: "someone-else",
      },
    ],
    payments: [],
    inserts: 0,
    paymentReads: 0,
    contractReads: 0,
    nextInsertError: null,
    nextId: 1,
  };
}

class Query {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.operation = "select";
    this.filters = [];
    this.payload = null;
  }
  select() {
    return this;
  }
  insert(payload) {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }
  eq(column, value) {
    this.filters.push(["eq", column, value]);
    return this;
  }
  in(column, values) {
    this.filters.push(["in", column, values]);
    return this;
  }
  order() {
    return this;
  }
  rows() {
    const rows = this.table === "payments" ? this.state.payments : this.state.contracts;
    return rows.filter((row) => this.filters.every(([kind, column, value]) =>
      kind === "eq" ? row[column] === value : value.includes(row[column])));
  }
  execute() {
    if (this.table === "profiles") {
      return { data: { role: this.state.role }, error: null };
    }
    if (this.operation === "insert") {
      this.state.inserts += 1;
      if (this.state.nextInsertError) {
        const error = this.state.nextInsertError;
        this.state.nextInsertError = null;
        return { data: null, error };
      }
      const duplicate = this.state.payments.find((row) =>
        row.created_by === this.payload.created_by && row.request_key === this.payload.request_key);
      if (duplicate) {
        return {
          data: null,
          error: {
            code: "23505",
            constraint: "idx_payments_request_key",
            message: 'duplicate key value violates unique constraint "idx_payments_request_key"',
          },
        };
      }
      const row = {
        id: `payment-${this.state.nextId++}`,
        ...this.payload,
        amount: Number(this.payload.amount).toFixed(2),
        created_at: new Date().toISOString(),
      };
      this.state.payments.push(row);
      return { data: { id: row.id, amount: row.amount }, error: null };
    }
    if (this.table === "payments") this.state.paymentReads += 1;
    if (this.table === "contracts") this.state.contractReads += 1;
    return { data: this.rows(), error: null };
  }
  async single() {
    if (this.operation === "insert") return this.execute();
    const result = this.execute();
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return row ? { data: row, error: null } : { data: null, error: { code: "PGRST116" } };
  }
  async maybeSingle() {
    const result = this.execute();
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return { data: row ?? null, error: result.error };
  }
  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

function createSupabase(state) {
  return {
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    from: (table) => new Query(state, table),
  };
}

function loadRoutes(state) {
  const supabase = createSupabase(state);
  const commonMocks = {
    "next/server": nextServer,
    "@/lib/supabase-server": { createServerSupabase: async () => supabase },
    "@/lib/logger": { logger, genReqId: () => "req-1" },
    "@/lib/payment-idempotency.mjs": paymentBoundary,
    "@/lib/payment-idempotency-server.mjs": paymentServer,
  };
  return {
    write: loadTypeScriptModule("src/app/api/payments/route.ts", commonMocks),
    list: loadTypeScriptModule("src/app/api/payments/list/route.ts", commonMocks),
  };
}

const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function paymentRequest(overrides = {}) {
  return new Request("https://app.newme.ae/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract_id: "contract-own",
      amount: 100.25,
      payment_date: "2026-08-13",
      payment_method: "bank_transfer",
      reference_no: null,
      notes: null,
      idempotencyKey: KEY,
      ...overrides,
    }),
  });
}

test("POST creates once, replays the same intent, and refuses a changed intent", async () => {
  const state = createState();
  const { write } = loadRoutes(state);

  const first = await write.POST(paymentRequest());
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(state.payments.length, 1);

  const replay = await write.POST(paymentRequest());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: created.id, amount: "100.25", idempotent_replay: true });
  assert.equal(state.payments.length, 1);

  const mismatch = await write.POST(paymentRequest({ amount: 100.26 }));
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(state.payments.length, 1);
  assert.equal(state.payments[0].amount, "100.25");
});

test("rounding-ambiguous amounts and unsupported methods are 400 with zero database writes", async () => {
  for (const overrides of [
    { amount: 1.005 },
    { payment_date: "2026-02-30" },
    { payment_method: "check" },
    { payment_method: "online" },
    { payment_method: "wire" },
    { reference_no: 123 },
  ]) {
    const state = createState();
    const { write } = loadRoutes(state);
    const response = await write.POST(paymentRequest(overrides));
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.equal((await response.json()).code, "INVALID_REQUEST");
    assert.equal(state.inserts, 0);
    assert.equal(state.contractReads, 0);
  }
});

test("all five database payment methods reach the canonical insert", async () => {
  for (const [index, payment_method] of paymentBoundary.PAYMENT_METHODS.entries()) {
    const state = createState();
    const { write } = loadRoutes(state);
    const response = await write.POST(paymentRequest({
      payment_method,
      idempotencyKey: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
    }));
    assert.equal(response.status, 201, payment_method);
    assert.equal(state.payments[0].payment_method, payment_method);
  }
});

test("sales may record only against an owned contract", async () => {
  const state = createState({ role: "sales", userId: "sales-1" });
  const { write } = loadRoutes(state);

  const own = await write.POST(paymentRequest());
  assert.equal(own.status, 201);

  const other = await write.POST(paymentRequest({
    contract_id: "contract-other",
    idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  }));
  assert.equal(other.status, 403);
  assert.equal(state.payments.length, 1);
});

test("an unrelated unique conflict is an insert failure, not an idempotent replay", async () => {
  const state = createState();
  state.nextInsertError = {
    code: "23505",
    constraint: "payments_reference_no_key",
    message: 'duplicate key value violates unique constraint "payments_reference_no_key"',
  };
  const { write } = loadRoutes(state);
  const response = await write.POST(paymentRequest());
  assert.equal(response.status, 500);
  assert.equal(state.payments.length, 0);
  assert.equal(state.paymentReads, 0);
});

test("a write is visible to the very next dashboard list read", async () => {
  const state = createState();
  const { write, list } = loadRoutes(state);

  const before = await list.GET(new Request("https://app.newme.ae/api/payments/list"));
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json()).payments, []);

  const created = await write.POST(paymentRequest());
  assert.equal(created.status, 201);

  const after = await list.GET(new Request("https://app.newme.ae/api/payments/list"));
  assert.equal(after.status, 200);
  assert.equal((await after.json()).payments.length, 1);
  assert.equal(after.headers.get("cache-control"), "private, no-store, max-age=0, must-revalidate");
  assert.equal(state.paymentReads, 2, "the second GET must query the current money rows again");
});
