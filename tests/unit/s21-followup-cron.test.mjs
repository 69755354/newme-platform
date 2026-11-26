// S21: the follow-up monitor cron route. It replaces the module loader for one load (Module._load), so
// scripts/run-node-tests.mjs runs it in its own process.
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
const SECRET = ["unit", "test", "cron", "value"].join("");

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

const dubai = (day, hm) => new Date(`${day}T${hm}:00+04:00`).toISOString();

/** A tiny in-memory stand-in for the tables the route reads and for upsert_lead_followup_state. */
function fakeDb({ conversations, leads, events, profiles, states = [] }) {
  const stateRows = new Map(states.map((s) => [s.lead_id, { ...s }]));
  const rpcCalls = [];
  const notes = [];
  const notifications = [];
  const run = (table, filters) => {
    const inFilter = (col) => filters.find((f) => f[0] === "in" && f[1] === col)?.[2];
    const eq = (col) => filters.find((f) => f[0] === "eq" && f[1] === col)?.[2];
    if (table === "whatsapp_conversations") return { data: conversations, error: null };
    if (table === "leads") return { data: leads.filter((l) => inFilter("id").includes(l.id)), error: null };
    if (table === "lead_followup_state") return { data: [...stateRows.values()].filter((s) => inFilter("lead_id").includes(s.lead_id)), error: null };
    if (table === "whatsapp_message_events") {
      const ids = inFilter("conversation_id");
      const lead = conversations.filter((c) => ids.includes(c.id)).map((c) => c.lead_id);
      return { data: events.filter((e) => lead.includes(e.lead_id)).map((e) => ({ direction: e.direction, occurred_at: e.occurred_at })), error: null };
    }
    if (table === "profiles") return { data: eq("role") === "operator" ? profiles : [], error: null };
    return { data: [], error: null };
  };
  const supabaseAdmin = {
    from(table) {
      const filters = [];
      const builder = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (resolve, reject) => Promise.resolve(run(table, filters)).then(resolve, reject);
          return (...args) => { filters.push([prop, ...args]); return builder; };
        },
      });
      return builder;
    },
    // Mirrors the database function: write only on a change.
    async rpc(name, args) {
      assert.equal(name, "upsert_lead_followup_state");
      rpcCalls.push(args);
      const prev = stateRows.get(args.p_lead_id);
      const prevState = prev?.state ?? "normal";
      const prevAbandon = prev?.abandon_risk ?? false;
      const changed = prevState !== args.p_state || prevAbandon !== args.p_abandon_risk;
      stateRows.set(args.p_lead_id, { lead_id: args.p_lead_id, state: args.p_state, abandon_risk: args.p_abandon_risk });
      let noteWritten = false; let notified = 0;
      if (changed && (prev || args.p_state !== "normal" || args.p_abandon_risk)) {
        if (args.p_note) { notes.push({ lead: args.p_lead_id, note: args.p_note }); noteWritten = true; }
        for (const user of args.p_notify_user_ids) { notifications.push({ user, title: args.p_notify_title }); notified += 1; }
      }
      return { data: { changed, note_written: noteWritten, notified }, error: null };
    },
  };
  return { supabaseAdmin, rpcCalls, notes, notifications, stateRows };
}

function load(db) {
  const NextResponse = { json: (body, init) => ({ status: init?.status ?? 200, body }) };
  return loadModule("src/app/api/cron/check-whatsapp-followups/route.ts", {
    "next/server": { NextResponse },
    "@/lib/supabase-admin": { supabaseAdmin: db.supabaseAdmin },
    "@/lib/logger": { logger: { error() {}, info() {}, warn() {} } },
    "@/lib/followup-monitor.mjs": require("node:module").createRequire(import.meta.url)("../../src/lib/followup-monitor.mjs"),
    // S43: the leave-cover helper (switch off in these tests: the owner list passes through unchanged)
    "@/lib/leave-cover.mjs": require("node:module").createRequire(import.meta.url)("../../src/lib/leave-cover.mjs"),
    "node:crypto": require("node:crypto"),
  });
}

const request = (secret = SECRET) => new Request("http://localhost/api/cron/check-whatsapp-followups", { headers: secret ? { "x-cron-secret": secret } : {} });
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OPERATOR = "00000000-0000-4000-8000-0000000000b1";
const QA = "00000000-0000-4000-8000-0000000000b2";
const base = () => ({
  conversations: [{ id: "c1", lead_id: "L1" }],
  leads: [{ id: "L1", assigned_to: OWNER, customer_name: "Test Customer", stage: "new", archived: false, final_status: null }],
  events: [{ lead_id: "L1", direction: "inbound", occurred_at: dubai("2026-11-18", "10:05") }],
  profiles: [{ id: OPERATOR, email: "ops@example.test" }, { id: QA, email: "qa-bot@qa.newme.ae" }],
});

test("a wrong or missing secret is refused and nothing is read", async () => {
  process.env.CRON_SECRET = SECRET; process.env.WHATSAPP_FOLLOWUP_MONITOR_ENABLED = "true";
  const db = fakeDb(base());
  const route = load(db);
  assert.equal((await route.GET(request("wrong"))).status, 401);
  assert.equal((await route.GET(request(""))).status, 401);
  assert.equal(db.rpcCalls.length, 0);
});

test("without the flag the route answers Disabled and does nothing", async () => {
  process.env.CRON_SECRET = SECRET; delete process.env.WHATSAPP_FOLLOWUP_MONITOR_ENABLED;
  const db = fakeDb(base());
  const response = await load(db).GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.body.message, "Disabled");
  assert.equal(db.rpcCalls.length, 0);
});

test("a lead that waited too long gets one note and one notification per recipient, test accounts excluded; a second run adds nothing", async () => {
  process.env.CRON_SECRET = SECRET; process.env.WHATSAPP_FOLLOWUP_MONITOR_ENABLED = "true";
  const db = fakeDb(base());
  const route = load(db);
  const savedNow = Date.now;
  Date.now = () => Date.parse(dubai("2026-11-18", "15:00"));
  try {
    const first = await route.GET(request());
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, 1);
    assert.equal(db.notes.length, 1);
    assert.match(db.notes[0].note, /\[系统\].*10:05.*\n\[System\]/);
    assert.deepEqual(db.notifications.map((n) => n.user).sort(), [OWNER, OPERATOR].sort());
    assert.equal(db.rpcCalls[0].p_state, "overdue");
    assert.ok(!db.notifications.some((n) => n.user === QA));
    const second = await route.GET(request());
    assert.equal(second.body.changed, 0);
    assert.equal(db.notes.length, 1);
    assert.equal(db.notifications.length, 2);
    assert.equal(db.rpcCalls[1].p_note, null, "no note is even offered while the state is unchanged");
  } finally { Date.now = savedNow; }
});

test("recovery is written once, and archived or closed leads are skipped", async () => {
  process.env.CRON_SECRET = SECRET; process.env.WHATSAPP_FOLLOWUP_MONITOR_ENABLED = "true";
  const data = base();
  data.leads.push({ id: "L2", assigned_to: OWNER, customer_name: "Closed", stage: "new", archived: false, final_status: "won" });
  data.conversations.push({ id: "c2", lead_id: "L2" });
  data.events.push({ lead_id: "L2", direction: "inbound", occurred_at: dubai("2026-11-16", "10:00") });
  const db = fakeDb(data);
  const route = load(db);
  const savedNow = Date.now;
  try {
    Date.now = () => Date.parse(dubai("2026-11-18", "15:00"));
    await route.GET(request());
    data.events.push({ lead_id: "L1", direction: "outbound", occurred_at: dubai("2026-11-18", "15:10") });
    Date.now = () => Date.parse(dubai("2026-11-18", "15:20"));
    const run = await route.GET(request());
    assert.equal(run.body.skipped_closed, 1);
    assert.equal(db.notes.length, 2);
    assert.match(db.notes[1].note, /恢复正常|back to normal|首次回复/);
    assert.ok(!db.rpcCalls.some((c) => c.p_lead_id === "L2"));
  } finally { Date.now = savedNow; }
});

test("the notification types written are the ones the database already allows", () => {
  const source = fs.readFileSync(path.join(root, "src/lib/followup-monitor.mjs"), "utf8");
  const types = new Set([...source.matchAll(/"(warning|reminder|[a-z_]+_reminder)"/g)].map((m) => m[1]));
  for (const t of types) assert.ok(["warning", "reminder"].includes(t), t);
});
