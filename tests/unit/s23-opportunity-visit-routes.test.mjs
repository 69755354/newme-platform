// S23: the opportunity and visit routes, run against an in-memory stand-in for the database. It replaces the
// module loader for the loads below (Module._load), so scripts/run-node-tests.mjs runs it in its own process.
// Row-level security, constraints, triggers and the workflow routines are proven by tests/database/s23-opportunities-visits.sql.
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
const LEAD1 = "23000000-0000-4000-8000-000000000001"; // assigned to SALES1
const LEAD2 = "23000000-0000-4000-8000-000000000002"; // assigned to SALES2
const STAGES = [
  { key: "new", label_en: "New", label_zh: "新建", sort_order: 10, requires_quote: false, is_closed: false, active: true },
  { key: "quotation_sent", label_en: "Quotation sent", label_zh: "已报价", sort_order: 20, requires_quote: true, is_closed: false, active: true },
];

class FakeAuthError extends Error { constructor(status) { super("auth"); this.status = status; } }

function makeDb(seed, { fail } = {}) {
  const tables = {
    leads: [{ id: LEAD1, assigned_to: SALES1, archived: false }, { id: LEAD2, assigned_to: SALES2, archived: false }],
    opportunity_stages: STAGES.map((s) => ({ ...s })), opportunities: [], visit_reports: [], ...seed,
  };
  const log = [];
  let counter = 100;
  const matches = (row, filters) => filters.every(([op, col, val]) => {
    if (op === "eq") return row[col] === val;
    if (op === "in") return val.includes(row[col]);
    if (op === "ilike") return String(row[col]).toLowerCase() === String(val).replace(/\\([\\%_])/g, "$1").toLowerCase();
    return true;
  });
  const exec = (q) => {
    log.push({ table: q.table, op: q.op, payload: q.payload });
    const injected = fail?.(q);
    if (injected) return { data: null, error: injected };
    const rows = tables[q.table] ?? [];
    if (q.op === "insert") {
      const dupe = q.table === "opportunities"
        ? rows.some((r) => !r.archived && r.lead_id === q.payload.lead_id && r.name.toLowerCase() === q.payload.name.toLowerCase())
        : q.table === "visit_reports" && rows.some((r) => !r.archived && r.lead_id === q.payload.lead_id && r.planned_at === q.payload.planned_at);
      if (dupe) return { data: null, error: { code: "23505" } };
      counter += 1;
      const row = { id: `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, opp_no: counter, visit_no: counter, archived: false, stage: "new",
        plan_approval: "pending", review_status: "pending", submitted_at: null, report_due_at: "2026-12-01T05:30:00.000Z", ...q.payload };
      rows.push(row);
      return { data: row, error: null };
    }
    const hit = rows.filter((r) => matches(r, q.filters));
    if (q.op === "update") { hit.forEach((r) => Object.assign(r, q.payload)); return q.single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null }; }
    if (q.single === "single") return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { code: "PGRST116" } };
    if (q.single === "maybeSingle") return { data: hit[0] ?? null, error: null };
    return { data: hit, error: null, count: hit.length };
  };
  const from = (table) => {
    const q = { table, op: "select", filters: [], payload: null, single: null };
    const builder = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (resolve, reject) => Promise.resolve(exec(q)).then(resolve, reject);
        if (prop === "insert" || prop === "update") return (payload) => { q.op = prop; q.payload = payload; return builder; };
        if (prop === "single" || prop === "maybeSingle") return () => { q.single = prop; return builder; };
        return (...args) => { q.filters.push([String(prop), ...args]); return builder; };
      },
    });
    return builder;
  };
  const rpcCalls = [];
  return { tables, log, rpcCalls, client: { from, async rpc(name, args) { rpcCalls.push({ name, args }); return { data: { changed: true, visits: 2, notified: 3 }, error: null }; } } };
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

const supabaseAdmin = new Proxy({}, { get: (_t, prop) => state.db.client[prop] ?? ((...a) => state.db.client.from(...a))[prop] });
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
  "@/lib/opportunity-visit.mjs": require(path.join(root, "src/lib/opportunity-visit.mjs")),
};
const api = loadModule("src/lib/opportunity-visit-api.ts", sharedMocks);
const mocksWithApi = { ...sharedMocks, "@/lib/opportunity-visit-api": api };
const route = (file) => loadModule(file, mocksWithApi);
const opportunities = route("src/app/api/opportunities/route.ts");
const opportunityOne = route("src/app/api/opportunities/[id]/route.ts");
const visits = route("src/app/api/visits/route.ts");
const visitOne = route("src/app/api/visits/[id]/route.ts");
const approve = route("src/app/api/visits/[id]/approve/route.ts");
const submit = route("src/app/api/visits/[id]/submit/route.ts");
const review = route("src/app/api/visits/[id]/review/route.ts");

function setup(role, userId, seed, options) {
  state.db = makeDb(seed, options);
  state.authFails = null;
  state.context = { user: { id: userId }, role, supabase: state.db.client };
  logs.length = 0;
}
const post = (url, body) => new Request(`http://app.test${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (url, body) => new Request(`http://app.test${url}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url) => new Request(`http://app.test${url}`);
const params = (id) => ({ params: Promise.resolve({ id }) });
const json = async (response) => response.json();
const NEW_OPP = { lead_id: LEAD1, name: "Villa A", confirmed_requirement: "3 bedrooms, full control" };
const PLAN = { lead_id: LEAD1, planned_at: "2026-11-25T06:00:00.000Z", purpose: "Walkthrough", location: "Showroom" };

test("unauthenticated callers get the auth answer and nothing is queried", async () => {
  setup("sales", SALES1);
  state.authFails = 401;
  const response = await opportunities.POST(post("/api/opportunities", NEW_OPP));
  assert.equal(response.status, 401);
  assert.equal(state.db.log.length, 0);
});

test("finance and designer are refused before any query, on every route", async () => {
  for (const role of ["finance", "designer"]) {
    setup(role, "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0");
    const calls = [
      opportunities.GET(get("/api/opportunities")), opportunities.POST(post("/api/opportunities", NEW_OPP)),
      opportunityOne.GET(get("/x"), params(LEAD1)), opportunityOne.PATCH(patch("/x", { name: "n" }), params(LEAD1)),
      visits.GET(get("/api/visits")), visits.POST(post("/api/visits", PLAN)),
      visitOne.GET(get("/x"), params(LEAD1)), visitOne.PATCH(patch("/x", { result: "r" }), params(LEAD1)),
      approve.POST(post("/x", { decision: "approved" }), params(LEAD1)), review.POST(post("/x", { decision: "accepted" }), params(LEAD1)),
      submit.POST(post("/x", {}), params(LEAD1)),
    ];
    for (const response of await Promise.all(calls)) assert.equal(response.status, 403, role);
    assert.equal(state.db.log.length, 0, `${role}: no query before the role check`);
    assert.equal(state.db.rpcCalls.length, 0);
  }
});

test("sales create on their own lead: owner is forced to themselves and unknown columns are dropped", async () => {
  setup("sales", SALES1);
  const response = await opportunities.POST(post("/api/opportunities", { ...NEW_OPP, owner_id: SALES2, created_by: SALES2, archived: true, id: "x", stage: "new" }));
  assert.equal(response.status, 201);
  const { data, duplicate } = await json(response);
  assert.equal(duplicate, false);
  assert.equal(data.owner_id, SALES1);
  assert.equal(data.created_by, SALES1);
  const insert = state.db.log.find((entry) => entry.op === "insert");
  assert.deepEqual(Object.keys(insert.payload).sort(), ["confirmed_requirement", "created_by", "lead_id", "name", "owner_id", "stage"]);
});

test("sales cannot create on a lead that is not theirs; staff can, and the owner defaults to the lead's owner", async () => {
  setup("sales", SALES1);
  assert.equal((await opportunities.POST(post("/api/opportunities", { ...NEW_OPP, lead_id: LEAD2 }))).status, 403);
  assert.equal(state.db.log.filter((entry) => entry.op === "insert").length, 0);
  for (const role of ["admin", "boss", "operator"]) {
    setup(role, OPERATOR);
    const response = await opportunities.POST(post("/api/opportunities", { ...NEW_OPP, lead_id: LEAD2 }));
    assert.equal(response.status, 201, role);
    assert.equal((await json(response)).data.owner_id, SALES2, role);
  }
  setup("operator", OPERATOR);
  assert.equal((await opportunities.POST(post("/api/opportunities", { ...NEW_OPP, lead_id: "23000000-0000-4000-8000-0000000000ff" }))).status, 404);
});

test("creating twice is idempotent; a different request with the same name is a conflict", async () => {
  setup("sales", SALES1);
  assert.equal((await opportunities.POST(post("/api/opportunities", NEW_OPP))).status, 201);
  const again = await opportunities.POST(post("/api/opportunities", { ...NEW_OPP, name: "villa a" }));
  assert.equal(again.status, 200);
  assert.equal((await json(again)).duplicate, true);
  assert.equal(state.db.tables.opportunities.length, 1);
  const different = await opportunities.POST(post("/api/opportunities", { ...NEW_OPP, confirmed_requirement: "something else" }));
  assert.equal(different.status, 409);
  assert.equal((await json(different)).error, "duplicate");
});

test("invalid input answers 422 with the field codes and writes nothing", async () => {
  setup("sales", SALES1);
  const response = await opportunities.POST(post("/api/opportunities", { ...NEW_OPP, stage: "quotation_sent", quote_amount_aed: -5, quotation_link: "http://x" }));
  assert.equal(response.status, 422);
  const body = await json(response);
  assert.equal(body.error, "validation_failed");
  assert.equal(body.fields.quote_amount_aed, "out_of_range");
  assert.equal(body.fields.quotation_link, "invalid");
  assert.equal(state.db.log.filter((entry) => entry.op === "insert").length, 0);
  const notJson = await opportunities.POST(new Request("http://app.test/api/opportunities", { method: "POST", body: "nope" }));
  assert.equal(notJson.status, 400);
});

test("updates cannot move an opportunity to another lead or (for sales) another owner, and respect the quote rule", async () => {
  setup("sales", SALES1);
  const id = (await json(await opportunities.POST(post("/api/opportunities", NEW_OPP)))).data.id;
  const moved = await opportunityOne.PATCH(patch("/x", { lead_id: LEAD2, owner_id: SALES2, name: "Villa A2" }), params(id));
  assert.equal(moved.status, 200);
  const row = state.db.tables.opportunities[0];
  assert.equal(row.lead_id, LEAD1);
  assert.equal(row.owner_id, SALES1);
  assert.equal(row.name, "Villa A2");
  const needsQuote = await opportunityOne.PATCH(patch("/x", { stage: "quotation_sent" }), params(id));
  assert.equal(needsQuote.status, 422);
  assert.equal((await json(needsQuote)).fields.quote_amount_aed, "quote_required");
  const empty = await opportunityOne.PATCH(patch("/x", {}), params(id));
  assert.equal(empty.status, 422);
  assert.equal((await opportunityOne.PATCH(patch("/x", { archived: true }), params(id))).status, 200);
  assert.equal(state.db.tables.opportunities[0].archived, true);
  // another sales person cannot touch it
  setup("sales", SALES2, { opportunities: state.db.tables.opportunities });
  assert.equal((await opportunityOne.PATCH(patch("/x", { name: "stolen" }), params(id))).status, 403);
  assert.equal((await opportunityOne.PATCH(patch("/x", { name: "n" }), params("not-a-uuid"))).status, 404);
});

test("visits: create, replay, conflict, and workflow columns are never accepted from the body", async () => {
  setup("sales", SALES1);
  const first = await visits.POST(post("/api/visits", { ...PLAN, plan_approval: "approved", submitted_at: "2026-01-01T00:00:00Z", review_status: "accepted", report_due_at: "2026-01-01T00:00:00Z", owner_id: SALES2 }));
  assert.equal(first.status, 201);
  const created = (await json(first)).data;
  assert.equal(created.status, "planned");
  assert.equal(created.owner_id, SALES1);
  const insert = state.db.log.find((entry) => entry.op === "insert");
  for (const key of ["plan_approval", "submitted_at", "review_status", "report_due_at"]) assert.equal(key in insert.payload, false, key);
  const replay = await visits.POST(post("/api/visits", PLAN));
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).duplicate, true);
  assert.equal((await visits.POST(post("/api/visits", { ...PLAN, purpose: "another purpose" }))).status, 409);
  assert.equal((await visits.POST(post("/api/visits", { ...PLAN, lead_id: LEAD2 }))).status, 403);
  assert.equal((await visits.POST(post("/api/visits", { ...PLAN, planned_at: "yesterday" }))).status, 422);
});

test("visit list carries the derived status and filters by it", async () => {
  setup("operator", OPERATOR, { visit_reports: [
    { id: "a", lead_id: LEAD1, planned_at: "2026-11-01T06:00:00Z", plan_approval: "approved", submitted_at: null, review_status: "pending", report_due_at: "2026-11-02T05:30:00Z", archived: false, purpose: "p", opportunity_id: null },
    { id: "b", lead_id: LEAD1, planned_at: "2027-06-01T06:00:00Z", plan_approval: "pending", submitted_at: null, review_status: "pending", report_due_at: "2027-06-02T05:30:00Z", archived: false, purpose: "q", opportunity_id: null },
  ] });
  const all = await json(await visits.GET(get("/api/visits")));
  assert.deepEqual(all.data.map((v) => v.status).sort(), ["overdue", "planned"]);
  const overdue = await json(await visits.GET(get("/api/visits?status=overdue")));
  assert.deepEqual(overdue.data.map((v) => v.id), ["a"]);
  assert.equal((await visits.GET(get("/api/visits?status=bogus"))).status, 400);
  assert.equal((await visits.GET(get("/api/visits?lead_id=bad"))).status, 400);
});

test("approving and reviewing: only staff, the actor is the signed-in user, bad input never reaches the database", async () => {
  const seed = { visit_reports: [{ id: "10000000-0000-4000-8000-000000000001", lead_id: LEAD1, plan_approval: "pending", archived: false }] };
  const id = "10000000-0000-4000-8000-000000000001";
  setup("sales", SALES1, seed);
  assert.equal((await approve.POST(post("/x", { decision: "approved" }), params(id))).status, 403);
  assert.equal((await review.POST(post("/x", { decision: "accepted" }), params(id))).status, 403);
  assert.equal(state.db.rpcCalls.length, 0);
  setup("operator", OPERATOR, seed);
  assert.equal((await approve.POST(post("/x", { decision: "maybe" }), params(id))).status, 422);
  assert.equal((await review.POST(post("/x", { decision: "needs_fix" }), params(id))).status, 422);
  assert.equal((await review.POST(post("/x", { decision: "bogus" }), params(id))).status, 422);
  assert.equal(state.db.rpcCalls.length, 0);
  const ok = await approve.POST(post("/x", { decision: "approved", note: "  go  ", p_actor: SALES1 }), params(id));
  assert.equal(ok.status, 200);
  assert.deepEqual(state.db.rpcCalls[0], { name: "visit_report_set_plan_approval", args: { p_visit_id: id, p_actor: OPERATOR, p_decision: "approved", p_note: "go" } });
  const reviewed = await review.POST(post("/x", { decision: "needs_fix", notes: "add photo", action_done: false }), params(id));
  assert.equal(reviewed.status, 200);
  assert.deepEqual(state.db.rpcCalls[1], { name: "visit_report_review", args: { p_visit_id: id, p_actor: OPERATOR, p_decision: "needs_fix", p_notes: "add photo", p_action_done: false } });
});

test("submitting: the sales owner of the lead or staff only, and the database decides if the report is complete", async () => {
  const id = "10000000-0000-4000-8000-000000000002";
  const seed = { visit_reports: [{ id, lead_id: LEAD1, archived: false }] };
  setup("sales", SALES2, seed);
  assert.equal((await submit.POST(post("/x", {}), params(id))).status, 403);
  assert.equal(state.db.rpcCalls.length, 0);
  setup("sales", SALES1, seed);
  assert.equal((await submit.POST(post("/x", {}), params(id))).status, 200);
  assert.deepEqual(state.db.rpcCalls[0], { name: "visit_report_submit", args: { p_visit_id: id, p_actor: SALES1 } });
  setup("sales", SALES1, seed, { fail: () => null });
  state.db.client.rpc = async () => ({ data: null, error: { code: "22023", message: "visit_plan_not_approved" } });
  const refused = await submit.POST(post("/x", {}), params(id));
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).error, "visit_plan_not_approved");
});

test("a database that does not have the tables yet answers 503 with a stable code and logs no message text", async () => {
  setup("sales", SALES1, {}, { fail: (q) => (q.table === "opportunities" ? { code: "42P01", message: "relation public.opportunities does not exist (secret detail)" } : null) });
  const response = await opportunities.GET(get("/api/opportunities"));
  assert.equal(response.status, 503);
  assert.equal((await json(response)).error, "feature_unavailable");
  assert.equal(JSON.stringify(logs).includes("secret detail"), false);
  setup("sales", SALES1, {}, { fail: () => ({ code: "XX000", message: "internal secret" }) });
  const failed = await visits.GET(get("/api/visits"));
  assert.equal(failed.status, 500);
  assert.equal(JSON.stringify(await json(failed)).includes("internal secret"), false);
});

test("the overdue route needs the secret, answers Disabled by default and calls the idempotent routine when enabled", async () => {
  const cron = loadModule("src/app/api/cron/check-visit-overdue/route.ts", { ...sharedMocks });
  const call = (headers = {}) => cron.GET(new Request("http://app.test/api/cron/check-visit-overdue", { headers }));
  const secret = ["unit", "cron", "value"].join("-");
  const previous = { secret: process.env.CRON_SECRET, flag: process.env.VISIT_OVERDUE_ALERTS_ENABLED };
  try {
    process.env.CRON_SECRET = secret;
    delete process.env.VISIT_OVERDUE_ALERTS_ENABLED;
    setup("admin", OPERATOR);
    assert.equal((await call()).status, 401);
    assert.equal((await call({ "x-cron-secret": "wrong" })).status, 401);
    const disabled = await call({ "x-cron-secret": secret });
    assert.equal(disabled.status, 200);
    assert.equal((await json(disabled)).message, "Disabled");
    assert.equal(state.db.rpcCalls.length, 0, "disabled by default: nothing is called");
    process.env.VISIT_OVERDUE_ALERTS_ENABLED = "true";
    const enabled = await json(await call({ "x-cron-secret": secret }));
    assert.deepEqual([enabled.ok, enabled.visits, enabled.notified], [true, 2, 3]);
    assert.equal(state.db.rpcCalls[0].name, "flag_overdue_visit_reports");
    assert.equal(state.db.log.length, 0, "the route writes nothing itself");
  } finally {
    for (const [key, value] of [["CRON_SECRET", previous.secret], ["VISIT_OVERDUE_ALERTS_ENABLED", previous.flag]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("nothing in the S23 routes touches Meta feedback or sends a message", () => {
  const files = ["src/lib/opportunity-visit-api.ts", "src/lib/opportunity-visit.mjs", "src/app/api/opportunities/route.ts", "src/app/api/visits/route.ts",
    "src/app/api/visits/[id]/route.ts", "src/app/api/visits/[id]/approve/route.ts", "src/app/api/visits/[id]/review/route.ts",
    "src/app/api/visits/[id]/submit/route.ts", "src/app/api/cron/check-visit-overdue/route.ts"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /whatsapp|capi|meta[-_]|graph\.facebook|sendMessage|fetch\(/i, file);
  }
});
