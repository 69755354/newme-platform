// S43 (B8): the website intake merges a repeat submission from the same open customer instead of opening a
// second lead -- behind NEWME_PUBLIC_LEAD_DEDUPE_ENABLED (default off) -- and never drops a lead.
// Fake database, no network. The loader replaces Module._load, so the runner gives this file its own process.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks = {}) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const { outputText } = ts.transpileModule(fsSync.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return previousLoad.call(this, request, parent, isMain);
  };
  try { loaded._compile(outputText, filename); return loaded.exports; } finally { Module._load = previousLoad; }
}

const OWNER = "a0000000-0000-4000-8000-000000000001";
const EXISTING = "b0000000-0000-4000-8000-000000000001";

function websiteRequest(body) {
  return new Request("https://app.newme.ae/api/public/leads", {
    method: "POST",
    headers: { origin: "https://newme.ae", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
    body: JSON.stringify(body),
  });
}

/** Tables: leads (with one open lead for +971 50 123 4567), activities, business_events, tasks. */
function loadRoute({ existing = true, lookupFails = false, lookupThrows = false } = {}) {
  const rows = { leads: new Map(), activities: new Map(), business_events: new Map(), tasks: new Map() };
  if (existing) {
    rows.leads.set(EXISTING, { id: EXISTING, phone: "050 123 4567", email: null, archived: false, final_status: null, assigned_to: OWNER,
      utm_source: null, campaign_name: "old campaign", created_at: "2026-11-20T08:00:00.000Z" });
  }
  const updates = [];
  const admin = {
    from(table) {
      let operation = "select", value, columns = "", filters = [], usedIlike = false;
      const run = async () => {
        if (operation === "insert") {
          const id = value.id ?? `${table}-${rows[table].size + 1}`;
          if (rows[table].has(id)) return { data: null, error: { code: "23505" } };
          rows[table].set(id, { ...value, id });
          return { data: { ...value, id }, error: null };
        }
        const matches = [...rows[table].values()].filter((entry) => filters.every(([key, expected]) => {
          const [column, field] = key.split("->>");
          const found = field ? entry[column]?.[field] : entry[column];
          return expected === null ? found == null : String(found) === String(expected);
        }));
        if (operation === "update") { for (const row of matches) { Object.assign(row, value); updates.push({ id: row.id, ...value }); } return { data: null, error: null }; }
        if (usedIlike && lookupThrows) throw new Error("unexpected");
        if (usedIlike && lookupFails) return { data: null, error: { code: "57014" } };
        return { data: matches, error: null };
      };
      const chain = {
        insert(input) { operation = "insert"; value = structuredClone(input); return chain; },
        update(input) { operation = "update"; value = structuredClone(input); return chain; },
        select(cols) { columns = cols ?? ""; return chain; },
        eq(key, expected) { filters.push([key, expected]); return chain; },
        is(key, expected) { filters.push([key, expected]); return chain; },
        ilike() { usedIlike = true; return chain; },
        order() { return chain; }, limit() { return chain; },
        single() { return chain.maybeSingle(); },
        async maybeSingle() { const r = await run(); return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r; },
        then(res, rej) { return run().then(res, rej); },
      };
      void columns;
      return chain;
    },
  };
  const tasks = [];
  const pings = [];
  const route = loadTypeScriptModule("src/app/api/public/leads/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/public-lead": loadTypeScriptModule("src/lib/public-lead.ts"),
    "@/lib/rate-limit": loadTypeScriptModule("src/lib/rate-limit.ts"),
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/tasks": { createFollowUpTask: async (_db, input) => { if (rows.tasks.has(input.taskId)) return { error: { code: "23505" } }; rows.tasks.set(input.taskId, input); tasks.push(input); return { error: null }; } },
    "@/lib/meta-capi": {
      buildMetaCapiLeadPayload: loadTypeScriptModule("src/lib/meta-capi.ts").buildMetaCapiLeadPayload,
      sendMetaCapiPayload: async () => {},
    },
    "@/lib/lead-intake-notify.mjs": { notifyNewLeadSafe: async (_db, lead) => { pings.push(lead); return { created: 1, skipped: 0 }; } },
    "@/lib/website-lead-identity": loadTypeScriptModule("src/lib/website-lead-identity.ts"),
    "@/lib/meta-capi-delivery": loadTypeScriptModule("src/lib/meta-capi-delivery.ts"),
    "@/lib/logger": { genReqId: () => "request-1", logger: { error() {}, warn() {}, info() {} } },
    // the alias is not resolvable from the compiled module: hand the real libraries over
    "@/lib/lead-dedupe.mjs": require("../../src/lib/lead-dedupe.mjs"),
    "@/lib/lead-contact.mjs": require("../../src/lib/lead-contact.mjs"),
    "@/lib/dubai-time.mjs": require("../../src/lib/dubai-time.mjs"),
  });
  return { route, rows, tasks, pings, updates };
}

const submission = (eventId) => ({ name: "Nadia", phone: "+971 50 123 4567", area: "Dubai Hills", message: "second time", event_id: eventId, utm_source: "google" });

test.beforeEach(() => {
  delete process.env.WEBSITE_LEAD_TURNSTILE_SECRET;
  delete process.env.NEWME_PUBLIC_LEAD_DEDUPE_ENABLED;
});

test("switch off (default): the same number from the website still opens a second lead, exactly as before", async () => {
  const { route, rows, pings } = loadRoute();
  const response = await route.POST(websiteRequest(submission("evt-off-1")));
  assert.equal(response.status, 201);
  assert.equal(rows.leads.size, 2);
  assert.equal(rows.activities.size, 0);
  assert.equal(pings.length, 1);
});

test("switch on: a 050 lead already open gets a note, the missing attribution, a task for its owner and the Meta event; no second lead", async () => {
  process.env.NEWME_PUBLIC_LEAD_DEDUPE_ENABLED = "true";
  const { route, rows, tasks, pings, updates } = loadRoute();
  const response = await route.POST(websiteRequest(submission("evt-on-1")));
  assert.equal(response.status, 201);
  // the anonymous caller must not learn that the number already belongs to an open lead
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(rows.leads.size, 1, "no second open lead");
  const note = [...rows.activities.values()][0];
  assert.equal(note.lead_id, EXISTING);
  assert.equal(note.type, "note");
  assert.equal(note.metadata.source, "website_form_resubmitted");
  assert.match(note.content, /second time/);
  // first attribution wins: campaign_name stays, the empty utm_source is filled
  assert.equal(rows.leads.get(EXISTING).campaign_name, "old campaign");
  assert.equal(rows.leads.get(EXISTING).utm_source, "google");
  assert.ok(updates.length >= 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].leadId, EXISTING);
  assert.equal(tasks[0].assigneeId, OWNER);
  assert.equal(pings.length, 0, "the existing lead already has its owner; the dispatchers are not pinged again");
  const delivery = [...rows.business_events.values()][0];
  assert.equal(delivery.lead_id, EXISTING);
  assert.equal(delivery.event_type, "meta_capi_lead_delivery");
  // a retry of the same submission is a no-op (same note id, same task id)
  const retry = await route.POST(websiteRequest(submission("evt-on-1")));
  assert.equal(retry.status, 201);
  assert.equal(rows.leads.size, 1);
  assert.equal(rows.activities.size, 1);
  assert.equal(tasks.length, 1);
});

test("switch on, no open match: a new lead is stored as before", async () => {
  process.env.NEWME_PUBLIC_LEAD_DEDUPE_ENABLED = "true";
  const { route, rows, pings } = loadRoute({ existing: false });
  const response = await route.POST(websiteRequest(submission("evt-on-2")));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(rows.leads.size, 1);
  assert.equal(pings.length, 1);
});

test("switch on, lookup fails: the lead is stored as a new lead -- never dropped", async () => {
  process.env.NEWME_PUBLIC_LEAD_DEDUPE_ENABLED = "true";
  const { route, rows } = loadRoute({ lookupFails: true });
  const response = await route.POST(websiteRequest(submission("evt-on-3")));
  assert.equal(response.status, 201);
  assert.equal(rows.leads.size, 2);
});

test("switch on, the dedupe path throws something unexpected: the submission is still stored as a new lead (201, never a 500)", async () => {
  process.env.NEWME_PUBLIC_LEAD_DEDUPE_ENABLED = "true";
  const { route, rows, pings } = loadRoute({ lookupThrows: true });
  const response = await route.POST(websiteRequest(submission("evt-on-4")));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(rows.leads.size, 2);
  assert.equal(pings.length, 1);
});

test("the merge note carries the Dubai calendar day, not the UTC day", async (t) => {
  process.env.NEWME_PUBLIC_LEAD_DEDUPE_ENABLED = "true";
  // 21:30 UTC on 24 Nov is 01:30 on 25 Nov in Dubai
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-24T21:30:00.000Z") });
  const { route, rows } = loadRoute();
  const response = await route.POST(websiteRequest(submission("evt-on-5")));
  assert.equal(response.status, 201);
  const note = [...rows.activities.values()][0];
  assert.match(note.content, /^Website form submitted again \(2026-11-25\)/);
});
