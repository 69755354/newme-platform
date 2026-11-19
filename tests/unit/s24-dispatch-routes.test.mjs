// S24: the dispatch and duplicate routes, run against an in-memory stand-in for the database. It replaces the
// module loader for the loads below (Module._load), so scripts/run-node-tests.mjs runs it in its own process.
// Constraints, triggers, row-level security and the routines are proven by tests/database/s24-dispatch-review.sql.
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

const SALES1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SALES2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPERATOR = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const L = (n) => `24000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REVIEW = "25000000-0000-4000-8000-000000000001";

class FakeAuthError extends Error { constructor(status) { super("auth"); this.status = status; } }

function seedTables() {
  return {
    leads: [
      { id: L(1), customer_name: "Amira Hassan", phone: "+971501110001", email: null, source: "website", source_channel: null, assigned_to: SALES1, created_at: "2026-11-01T08:00:00Z", archived: false, notes: "private" },
      { id: L(2), customer_name: "Amira H.", phone: "+971501110001", email: null, source: "website", source_channel: null, assigned_to: SALES2, created_at: "2026-11-02T08:00:00Z", archived: false, notes: "private" },
      { id: L(3), customer_name: "Bilal", phone: "+971501110003", email: null, source: "website", source_channel: null, assigned_to: null, created_at: "2026-11-03T08:00:00Z", archived: false },
    ],
    lead_dispatch_state: [
      { lead_id: L(1), status: "delivered", missing_fields: [], phone_norm: "+971501110001", phone_flag: "ok", routing_note: "ready", admin_note: null, release_reason: null, evaluated_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" },
      { lead_id: L(2), status: "duplicate_review", missing_fields: [], phone_norm: "+971501110001", phone_flag: "ok", routing_note: "matches an older lead on phone", admin_note: null, release_reason: null, evaluated_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-03T00:00:00Z" },
      { lead_id: L(3), status: "unassigned", missing_fields: [], phone_norm: "+971501110003", phone_flag: "ok", routing_note: "no owner", admin_note: null, release_reason: null, evaluated_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-03T00:00:00Z" },
    ],
    duplicate_reviews: [
      { id: REVIEW, lead_id: L(2), duplicate_of_lead_id: L(1), candidate_ids: [L(1)], matched_on: ["phone"], decision: "pending", notes: null, decided_by: null, decided_at: null, created_at: "2026-11-02T00:00:00Z" },
    ],
  };
}

function makeDb({ fail, rpcResult } = {}) {
  const tables = seedTables();
  const log = [];
  const rpcCalls = [];
  const matches = (row, filters, table) => filters.every(([op, col, val]) => {
    if (col.startsWith("leads.")) { // embedded inner join on the lead of a dispatch state row
      const lead = tables.leads.find((l) => l.id === row.lead_id);
      return Boolean(lead) && op === "eq" && lead[col.slice(6)] === val;
    }
    if (op === "eq") return row[col] === val;
    if (op === "in") return val.includes(row[col]);
    return true;
  });
  const exec = (q) => {
    log.push({ table: q.table, op: q.op, columns: q.columns, filters: q.filters, range: q.range, head: q.head });
    const injected = fail?.(q);
    if (injected) return { data: null, error: injected };
    const hit = (tables[q.table] ?? []).filter((r) => matches(r, q.filters, q.table));
    if (q.head) return { data: null, error: null, count: hit.length };
    // the database returns only the selected columns
    const names = q.columns && q.columns !== "*" ? q.columns.split(",").map((c) => c.trim()) : null;
    let rows = names ? hit.map((r) => Object.fromEntries(names.filter((c) => c in r).map((c) => [c, r[c]]))) : hit;
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    if (q.single === "maybeSingle") return { data: rows[0] ?? null, error: null };
    if (q.single === "single") return rows.length ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116" } };
    return { data: rows, error: null, count: hit.length };
  };
  const from = (table) => {
    const q = { table, op: "select", filters: [], columns: null, range: null, single: null, head: false };
    const builder = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (resolve, reject) => Promise.resolve(exec(q)).then(resolve, reject);
        if (prop === "insert" || prop === "update" || prop === "delete" || prop === "upsert") return () => { q.op = prop; return builder; };
        if (prop === "select") return (columns, options) => { q.columns = columns; q.head = Boolean(options?.head); return builder; };
        if (prop === "range") return (a, b) => { q.range = [a, b]; return builder; };
        if (prop === "single" || prop === "maybeSingle") return () => { q.single = prop; return builder; };
        return (...args) => { q.filters.push([String(prop), ...args]); return builder; };
      },
    });
    return builder;
  };
  return {
    tables, log, rpcCalls,
    client: {
      from,
      async rpc(name, args) {
        rpcCalls.push({ name, args });
        const injected = fail?.({ rpc: name, args });
        if (injected) return { data: null, error: injected };
        return { data: rpcResult?.[name] ?? { changed: true, status: "delivered", evaluated: 4 }, error: null };
      },
    },
  };
}

const state = { db: null, context: null, authFails: null };
const logs = [];

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain));
  try { loaded._compile(outputText, filename); return loaded.exports; } finally { Module._load = previousLoad; }
}

const sharedMocks = {
  "server-only": {},
  "@/lib/supabase-admin": { supabaseAdmin: { from: (...a) => state.db.client.from(...a), rpc: (...a) => state.db.client.rpc(...a) } },
  "@/lib/logger": { logger: { error: (payload) => logs.push(payload) } },
  "@/lib/request-auth-context": {
    RequestAuthError: FakeAuthError,
    getRequestAuthContext: async () => { if (state.authFails) throw new FakeAuthError(state.authFails); return state.context; },
    applyRequestAuthCookies: (_c, response) => response,
    requestAuthErrorResponse: (error) => new Response(JSON.stringify({ error: "auth" }), { status: error.status }),
  },
  "@/lib/lead-dispatch.mjs": require(path.join(root, "src/lib/lead-dispatch.mjs")),
};
const api = loadModule("src/lib/lead-dispatch-api.ts", sharedMocks);
const mocksWithApi = { ...sharedMocks, "@/lib/lead-dispatch-api": api };
const route = (file) => loadModule(file, mocksWithApi);
const queue = route("src/app/api/dispatch/queue/route.ts");
const refresh = route("src/app/api/dispatch/refresh/route.ts");
const oneLead = route("src/app/api/dispatch/[leadId]/route.ts");
const decide = route("src/app/api/dispatch/[leadId]/decide/route.ts");
const duplicates = route("src/app/api/duplicates/route.ts");
const duplicateOne = route("src/app/api/duplicates/[id]/route.ts");
const resolve = route("src/app/api/duplicates/[id]/resolve/route.ts");
const reopen = route("src/app/api/duplicates/[id]/reopen/route.ts");

function setup(role, userId, options) {
  state.db = makeDb(options);
  state.authFails = null;
  state.context = { user: { id: userId }, role, supabase: state.db.client };
  logs.length = 0;
}
const post = (url, body) => new Request(`http://app.test${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url) => new Request(`http://app.test${url}`);
const leadParams = (leadId) => ({ params: Promise.resolve({ leadId }) });
const idParams = (id) => ({ params: Promise.resolve({ id }) });
const json = async (response) => response.json();

test("unauthenticated callers get the auth answer and nothing is queried", async () => {
  setup("operator", OPERATOR);
  state.authFails = 401;
  assert.equal((await queue.GET(get("/api/dispatch/queue"))).status, 401);
  assert.equal(state.db.log.length, 0);
});

test("sales, finance and designer cannot use the workbench routes and nothing is queried", async () => {
  for (const role of ["sales", "finance", "designer"]) {
    setup(role, SALES1);
    const calls = [
      queue.GET(get("/api/dispatch/queue")), refresh.POST(post("/api/dispatch/refresh", {})),
      decide.POST(post("/x", { action: "reevaluate" }), leadParams(L(1))),
      duplicates.GET(get("/api/duplicates")), duplicateOne.GET(get("/x"), idParams(REVIEW)),
      resolve.POST(post("/x", { decision: "merged" }), idParams(REVIEW)), reopen.POST(post("/x", { reason: "mistake" }), idParams(REVIEW)),
    ];
    for (const response of await Promise.all(calls)) assert.equal(response.status, 403, role);
    assert.equal(state.db.log.length, 0, `${role}: no query before the role check`);
    assert.equal(state.db.rpcCalls.length, 0);
  }
});

test("the queue answers counts for all seven states and the rows of one state", async () => {
  for (const role of ["admin", "boss", "operator"]) {
    setup(role, OPERATOR);
    const response = await queue.GET(get("/api/dispatch/queue?status=duplicate_review"));
    assert.equal(response.status, 200, role);
    const body = await json(response);
    assert.deepEqual(Object.keys(body.counts).sort(), ["delivered", "duplicate_not_dispatched", "duplicate_review", "excluded_test", "missing_intake_data", "review_phone", "unassigned"]);
    assert.equal(body.counts.duplicate_review, 1);
    assert.equal(body.counts.delivered, 1);
    assert.equal(body.status, "duplicate_review");
    assert.equal(body.data.length, 1);
    const row = body.data[0];
    assert.equal(row.lead_id, L(2));
    assert.equal(row.lead.customer_name, "Amira H.");
    assert.equal(row.duplicate.review_id, REVIEW);
    assert.equal(row.duplicate.original.id, L(1));
    assert.deepEqual(row.allowed_actions, ["mark_test", "note", "reevaluate"]);
    assert.equal("notes" in row.lead, false, "free-text customer notes are not returned");
  }
});

test("the queue leaves archived leads out of the rows and the counts, and keeps the response shape", async () => {
  setup("admin", OPERATOR);
  state.db.tables.leads.find((l) => l.id === L(3)).archived = true; // archived by /api/leads/archive
  const body = await json(await queue.GET(get("/api/dispatch/queue?status=unassigned")));
  assert.equal(body.counts.unassigned, 0);
  assert.equal(body.data.length, 0);
  assert.equal(body.pagination.total, 0);
  const other = await json(await queue.GET(get("/api/dispatch/queue?status=duplicate_review")));
  assert.equal(other.counts.duplicate_review, 1);
  assert.equal("leads" in other.data[0], false, "the join column is not leaked into the rows");
  const filters = state.db.log.filter((e) => e.table === "lead_dispatch_state").map((e) => JSON.stringify(e.filters));
  assert.ok(filters.every((f) => f.includes("leads.archived")), "every state query filters archived leads");
});

test("the queue defaults to the first attention state, validates the filter and caps the page size", async () => {
  setup("operator", OPERATOR);
  assert.equal((await json(await queue.GET(get("/api/dispatch/queue")))).status, "missing_intake_data");
  assert.equal((await queue.GET(get("/api/dispatch/queue?status=bogus"))).status, 400);
  await queue.GET(get("/api/dispatch/queue?status=unassigned&limit=9999&offset=3"));
  const paged = state.db.log.filter((e) => e.table === "lead_dispatch_state" && e.range);
  assert.deepEqual(paged.at(-1).range, [3, 3 + 200 - 1]);
  assert.ok(state.db.log.every((e) => e.op === "select"), "the queue only reads");
  const leadColumns = state.db.log.filter((e) => e.table === "leads").map((e) => e.columns).join(",");
  assert.equal(/notes|raw_import|smart_requirements/.test(leadColumns), false);
});

test("one lead: staff see the full state, sales only their own lead and only the label", async () => {
  setup("operator", OPERATOR);
  const staff = await json(await oneLead.GET(get("/x"), leadParams(L(2))));
  assert.equal(staff.data.status, "duplicate_review");
  assert.equal(staff.data.routing_note, "matches an older lead on phone");
  assert.equal(staff.data.duplicate.review_id, REVIEW);
  setup("sales", SALES1);
  const own = await oneLead.GET(get("/x"), leadParams(L(1)));
  assert.equal(own.status, 200);
  assert.deepEqual(Object.keys((await json(own)).data).sort(), ["missing_fields", "status"]);
  assert.equal((await oneLead.GET(get("/x"), leadParams(L(2)))).status, 403);
  assert.equal((await oneLead.GET(get("/x"), leadParams("not-a-uuid"))).status, 404);
  setup("operator", OPERATOR);
  assert.equal((await oneLead.GET(get("/x"), leadParams(L(9)))).status, 404);
});

test("a lead without a state row answers data null, not an error", async () => {
  setup("operator", OPERATOR);
  state.db.tables.lead_dispatch_state.length = 0;
  const response = await oneLead.GET(get("/x"), leadParams(L(1)));
  assert.equal(response.status, 200);
  assert.equal((await json(response)).data, null);
});

test("decide validates the body, then calls the routine with the signed-in actor", async () => {
  setup("operator", OPERATOR);
  const bad = await decide.POST(post("/x", { action: "release_missing", reason: "short" }), leadParams(L(3)));
  assert.equal(bad.status, 422);
  assert.deepEqual((await json(bad)).fields, { reason: "required" });
  assert.equal((await decide.POST(post("/x", { action: "teleport" }), leadParams(L(3)))).status, 422);
  assert.equal((await decide.POST(post("/x", { action: "reevaluate" }), leadParams("nope"))).status, 404);
  assert.equal(state.db.rpcCalls.length, 0);
  const ok = await decide.POST(post("/x", { action: "mark_test", reason: "internal trial entry", p_actor: SALES1 }), leadParams(L(3)));
  assert.equal(ok.status, 200);
  assert.deepEqual(state.db.rpcCalls.at(-1), { name: "dispatch_decide", args: { p_lead_id: L(3), p_actor: OPERATOR, p_action: "mark_test", p_reason: "internal trial entry" } });
});

test("routine errors map to stable codes and never leak details", async () => {
  const cases = [
    [{ code: "42501", message: "dispatch_decision_not_allowed" }, 403, "forbidden"],
    [{ code: "22023", message: "phone_not_confirmable" }, 409, "phone_not_confirmable"],
    [{ code: "22023", message: "unknown_lead" }, 404, "unknown_lead"],
    [{ code: "42883", message: "function does not exist" }, 503, "feature_unavailable"],
    [{ code: "XX000", message: "relation secret_table detail" }, 500, "internal"],
  ];
  for (const [error, status, code] of cases) {
    setup("operator", OPERATOR, { fail: (q) => (q.rpc ? error : null) });
    const response = await decide.POST(post("/x", { action: "confirm_phone" }), leadParams(L(3)));
    assert.equal(response.status, status);
    const body = await json(response);
    assert.equal(body.error, code);
    assert.equal(JSON.stringify(body).includes("secret_table"), false);
  }
});

test("a missing table answers 503 with a stable code on reads", async () => {
  setup("operator", OPERATOR, { fail: (q) => (q.table === "lead_dispatch_state" ? { code: "42P01" } : null) });
  const response = await queue.GET(get("/api/dispatch/queue"));
  assert.equal(response.status, 503);
  assert.equal((await json(response)).error, "feature_unavailable");
});

test("refresh runs the bounded sweep with a seven-day window and a hundred leads", async () => {
  setup("operator", OPERATOR);
  const before = Date.now();
  const response = await refresh.POST(post("/api/dispatch/refresh", {}));
  assert.equal(response.status, 200);
  const call = state.db.rpcCalls.at(-1);
  assert.equal(call.name, "sweep_lead_dispatch");
  assert.equal(call.args.p_limit, 100);
  const age = before - Date.parse(call.args.p_since);
  assert.ok(Math.abs(age - 7 * 24 * 3600 * 1000) < 60_000, "window is seven days");
  assert.equal((await json(response)).evaluated, 4);
});

test("the duplicate list and detail show both leads side by side, without customer notes", async () => {
  setup("operator", OPERATOR);
  const list = await json(await duplicates.GET(get("/api/duplicates")));
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].lead.id, L(2));
  assert.equal(list.data[0].original.id, L(1));
  assert.equal(list.data[0].decision, "pending");
  assert.equal((await duplicates.GET(get("/api/duplicates?decision=bogus"))).status, 400);
  const detail = await json(await duplicateOne.GET(get("/x"), idParams(REVIEW)));
  assert.equal(detail.data.lead.customer_name, "Amira H.");
  assert.equal(detail.data.candidates[0].customer_name, "Amira Hassan");
  assert.equal("notes" in detail.data.lead, false);
  assert.equal((await duplicateOne.GET(get("/x"), idParams("nope"))).status, 404);
  setup("operator", OPERATOR);
  assert.equal((await duplicateOne.GET(get("/x"), idParams("25000000-0000-4000-8000-0000000000ff"))).status, 404);
});

test("resolve and reopen call the routines with the actor and validated input", async () => {
  setup("boss", OPERATOR);
  assert.equal((await resolve.POST(post("/x", { decision: "invalid", notes: "no" }), idParams(REVIEW))).status, 422);
  assert.equal((await resolve.POST(post("/x", { decision: "maybe" }), idParams(REVIEW))).status, 422);
  assert.equal((await resolve.POST(post("/x", { decision: "merged" }), idParams("nope"))).status, 404);
  assert.equal(state.db.rpcCalls.length, 0);
  assert.equal((await resolve.POST(post("/x", { decision: "kept_separate", notes: "two people", p_actor: SALES1 }), idParams(REVIEW))).status, 200);
  assert.deepEqual(state.db.rpcCalls.at(-1), { name: "resolve_duplicate_review", args: { p_review_id: REVIEW, p_actor: OPERATOR, p_decision: "kept_separate", p_notes: "two people" } });
  assert.equal((await reopen.POST(post("/x", { reason: "no" }), idParams(REVIEW))).status, 422);
  assert.equal((await reopen.POST(post("/x", { reason: "decided by mistake" }), idParams(REVIEW))).status, 200);
  assert.deepEqual(state.db.rpcCalls.at(-1), { name: "reopen_duplicate_review", args: { p_review_id: REVIEW, p_actor: OPERATOR, p_reason: "decided by mistake" } });
  setup("operator", OPERATOR, { fail: (q) => (q.rpc ? { code: "22023", message: "review_already_decided" } : null) });
  const conflict = await resolve.POST(post("/x", { decision: "merged" }), idParams(REVIEW));
  assert.equal(conflict.status, 409);
});

test("no route writes a table directly, sends a notification or touches Meta data", async () => {
  setup("operator", OPERATOR);
  await queue.GET(get("/api/dispatch/queue?status=review_phone"));
  await duplicates.GET(get("/api/duplicates"));
  await decide.POST(post("/x", { action: "reevaluate" }), leadParams(L(1)));
  await resolve.POST(post("/x", { decision: "merged" }), idParams(REVIEW));
  assert.ok(state.db.log.every((e) => e.op === "select"));
  assert.equal(state.db.log.some((e) => /notification|whatsapp_capi|meta_/.test(e.table)), false);
  assert.ok(state.db.rpcCalls.every((c) => ["dispatch_decide", "resolve_duplicate_review", "reopen_duplicate_review", "sweep_lead_dispatch"].includes(c.name)));
});

test("the sweep cron route is closed without the secret and disabled without its flag", async () => {
  const cron = loadModule("src/app/api/cron/dispatch-sweep/route.ts", { ...sharedMocks });
  const call = (headers = {}) => cron.GET(new Request("http://app.test/api/cron/dispatch-sweep", { headers }));
  const secret = ["unit", "cron", "value"].join("-");
  const savedSecret = process.env.CRON_SECRET;
  const savedFlag = process.env.DISPATCH_SWEEP_ENABLED;
  try {
    process.env.CRON_SECRET = secret;
    delete process.env.DISPATCH_SWEEP_ENABLED;
    setup("operator", OPERATOR);
    assert.equal((await call()).status, 401);
    assert.equal((await call({ "x-cron-secret": "wrong" })).status, 401);
    const disabled = await call({ "x-cron-secret": secret });
    assert.equal(disabled.status, 200);
    assert.equal((await json(disabled)).message, "Disabled");
    assert.equal(state.db.rpcCalls.length, 0);
    process.env.DISPATCH_SWEEP_ENABLED = "true";
    const enabled = await json(await call({ "x-cron-secret": secret }));
    assert.equal(enabled.ok, true);
    assert.equal(state.db.rpcCalls.at(-1).name, "sweep_lead_dispatch");
    setup("operator", OPERATOR, { fail: (q) => (q.rpc ? { code: "XX000", message: "secret detail" } : null) });
    const failed = await call({ "x-cron-secret": secret });
    assert.equal(failed.status, 500);
    assert.equal(JSON.stringify(await json(failed)).includes("secret detail"), false);
  } finally {
    if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret;
    if (savedFlag === undefined) delete process.env.DISPATCH_SWEEP_ENABLED; else process.env.DISPATCH_SWEEP_ENABLED = savedFlag;
  }
});
