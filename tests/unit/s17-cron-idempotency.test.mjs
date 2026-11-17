// S17 B-1: the two cron routes that write notifications are scheduled once a day by systemd timers
// (infra/cron). A retry, a manual re-run or a Persistent= catch-up must not write the same
// notification twice, and the reminder's "today" must be the Dubai day whatever the process timezone.
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
const SECRET = "unit-test-cron-value";

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

/** Chainable, awaitable stand-in for supabaseAdmin; `handler({table, kind, filters, row})` answers each query. */
function fakeAdmin(handler) {
  return {
    from(table) {
      const q = { table, kind: "select", filters: [], row: undefined };
      const builder = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (resolve, reject) => Promise.resolve(handler(q)).then(resolve, reject);
          return (...args) => {
            if (prop === "insert" || prop === "update" || prop === "delete") { q.kind = prop; q.row = args[0]; }
            else q.filters.push([prop, ...args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
}

const NextResponse = { json: (body, init) => ({ status: init?.status ?? 200, body }) };
const request = () => new Request("http://localhost/api/cron/x", { headers: { "x-cron-secret": SECRET } });
const filterValue = (q, name, column) => q.filters.find((f) => f[0] === name && (column === undefined || f[1] === column))?.[2];

test("check-no-answer does not warn again while nothing new has been logged", async () => {
  process.env.CRON_SECRET = SECRET;
  const inserts = [];
  const flags = [];
  const admin = fakeAdmin((q) => {
    if (q.table === "leads" && q.kind === "select") return { data: [{ id: "lead-1", assigned_to: "user-1", customer_name: "A" }], error: null };
    if (q.table === "follow_up_logs") {
      return { data: [1, 2, 3].map((n) => ({ id: `log-${n}`, no_answer: true, created_at: `2026-11-17T0${n}:00:00Z` })), error: null };
    }
    if (q.table === "leads" && q.kind === "update") { flags.push(q.row); return { error: null }; }
    if (q.table === "notifications" && q.kind === "select") {
      // The warning written by the previous run is newer than the newest log: nothing to repeat.
      const since = filterValue(q, "gte", "created_at");
      return { data: inserts.filter((r) => r.created_at >= since).map((r) => ({ id: "n" })), error: null };
    }
    if (q.table === "notifications" && q.kind === "insert") { inserts.push({ ...q.row, created_at: "2026-11-18T04:10:00Z" }); return { error: null }; }
    throw new Error(`unexpected ${q.kind} on ${q.table}`);
  });
  const { GET } = loadModule("src/app/api/cron/check-no-answer/route.ts", { "next/server": { NextResponse }, "@/lib/supabase-admin": { supabaseAdmin: admin } });
  const first = await GET(request());
  const second = await GET(request());
  assert.equal(first.status, 200);
  assert.equal(first.body.notifications, 1, "first run warns");
  assert.equal(second.status, 200);
  assert.equal(second.body.notifications, 0, "second run is a no-op for notifications");
  assert.equal(inserts.length, 1, "exactly one warning was written");
  assert.equal(flags.length, 2, "the flag update itself is idempotent");
});

test("check-no-answer does not write a duplicate when it cannot tell whether one exists", async () => {
  process.env.CRON_SECRET = SECRET;
  let inserted = 0;
  const admin = fakeAdmin((q) => {
    if (q.table === "leads" && q.kind === "select") return { data: [{ id: "lead-1", assigned_to: "user-1", customer_name: "A" }], error: null };
    if (q.table === "follow_up_logs") return { data: [1, 2, 3].map((n) => ({ id: `l${n}`, no_answer: true, created_at: "2026-11-17T01:00:00Z" })), error: null };
    if (q.table === "leads") return { error: null };
    if (q.table === "notifications" && q.kind === "select") return { data: null, error: { message: "boom" } };
    if (q.table === "notifications" && q.kind === "insert") { inserted += 1; return { error: null }; }
    throw new Error("unexpected");
  });
  const { GET } = loadModule("src/app/api/cron/check-no-answer/route.ts", { "next/server": { NextResponse }, "@/lib/supabase-admin": { supabaseAdmin: admin } });
  const res = await GET(request());
  assert.equal(res.status, 200);
  assert.equal(inserted, 0);
});

test("daily-reminder writes one reminder per assignee per Dubai day and uses the Dubai day window", async () => {
  process.env.CRON_SECRET = SECRET;
  const inserts = [];
  let taskWindow = null;
  const admin = fakeAdmin((q) => {
    if (q.table === "tasks") {
      taskWindow = { gte: filterValue(q, "gte", "due_at"), lte: filterValue(q, "lte", "due_at") };
      return { data: [{ id: "task-1", title: "Call", assignee_id: "user-1", due_at: "2026-11-18T05:00:00Z", leads: { id: "l", customer_name: "A" } }], error: null };
    }
    if (q.table === "notifications" && q.kind === "select") {
      const since = filterValue(q, "gte", "created_at");
      return { data: inserts.filter((r) => r.created_at >= since).map(() => ({ id: "n" })), error: null };
    }
    if (q.table === "notifications" && q.kind === "insert") { inserts.push({ ...q.row, created_at: "2026-11-18T04:00:30Z" }); return { error: null }; }
    throw new Error(`unexpected ${q.kind} on ${q.table}`);
  });
  const { dubaiDate } = await import("../../src/lib/daily-digest.mjs");
  const { GET } = loadModule("src/app/api/cron/daily-reminder/route.ts", {
    "next/server": { NextResponse }, "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/daily-digest.mjs": { dubaiDate: () => "2026-11-18" },
  });
  assert.equal(typeof dubaiDate, "function");
  const first = await GET(request());
  const second = await GET(request());
  assert.equal(first.body.notificationsCreated, 1);
  assert.equal(second.body.notificationsCreated, 0, "the same day's reminder is not written twice");
  assert.equal(inserts.length, 1);
  // 2026-11-18 in Dubai (UTC+4) runs from 2026-11-17T20:00Z to 2026-11-18T19:59:59.999Z, whatever TZ the process has.
  assert.equal(taskWindow.gte, "2026-11-17T20:00:00.000Z");
  assert.equal(taskWindow.lte, "2026-11-18T19:59:59.999Z");
});
