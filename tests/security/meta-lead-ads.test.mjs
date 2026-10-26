import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import {
  extractLeadgenNotifications, mapMetaLeadToRow, storeMetaLead, verifyMetaSignature,
} from "../../src/lib/meta-lead-ads.mjs";
import { pullMetaLeads } from "../../scripts/meta-leads-pull.mjs";

const PAGE = "770232832850803";
const NOW = Date.parse("2026-10-26T00:00:00Z"); // graphLead() is created 2026-10-20
const LEAD = "1234567890123456";
const sign = (body, secret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("signature: exact App Secret HMAC only", () => {
  const body = Buffer.from('{"object":"page"}');
  assert.equal(verifyMetaSignature(body, sign(body, "s3cret"), "s3cret"), true);
  assert.equal(verifyMetaSignature(body, sign(body, "other"), "s3cret"), false);
  assert.equal(verifyMetaSignature(body, null, "s3cret"), false);
  assert.equal(verifyMetaSignature(body, "sha256=zz", "s3cret"), false);
  assert.equal(verifyMetaSignature(body, sign(body, "s3cret"), ""), false);
});

test("extraction: leadgen changes on allowlisted pages, deduplicated", () => {
  const payload = { object: "page", entry: [
    { id: PAGE, changes: [
      { field: "leadgen", value: { page_id: PAGE, leadgen_id: LEAD, form_id: "998877665544", created_time: 1_790_000_000 } },
      { field: "leadgen", value: { page_id: PAGE, leadgen_id: LEAD } },
      { field: "feed", value: { page_id: PAGE } },
      { field: "leadgen", value: { page_id: "11111111111", leadgen_id: "2234567890123456" } },
      { field: "leadgen", value: { page_id: PAGE, leadgen_id: "1; drop table" } },
    ] },
  ] };
  const out = extractLeadgenNotifications(payload, [PAGE]);
  assert.equal(out.length, 1);
  assert.equal(out[0].leadgen_id, LEAD);
  assert.throws(() => extractLeadgenNotifications({ object: "user", entry: [] }, [PAGE]));
});

const graphLead = (id = LEAD, extra = {}) => ({
  id, created_time: "2026-10-20T09:15:00+0000", platform: "ig", form_id: "998877665544",
  ad_id: "120249679465810743", ad_name: "Static-2", adset_id: "120249626000270743", adset_name: "Home_OWNERS-35-60-MP",
  campaign_id: "120249626000250743", campaign_name: "Newme_SMHS_UAE_ABO_18SEPT",
  field_data: [
    { name: "full_name", values: ["Test Person"] },
    { name: "phone_number", values: ["+971 50 123 4567"] },
    { name: "email", values: ["Test@Example.com"] },
    { name: "which_community?", values: ["Palm Jumeirah"] },
  ],
  ...extra,
});

test("mapping: attribution, normalized contacts, creation time and raw answers", () => {
  const row = mapMetaLeadToRow(graphLead(), { formName: "Villa form", now: new Date("2026-10-26T00:00:00Z") });
  assert.equal(row.meta_leadgen_id, LEAD);
  assert.equal(row.source, "ins");
  assert.equal(row.phone, "+971501234567");
  assert.equal(row.email, "test@example.com");
  assert.equal(row.ad_name, "Static-2");
  assert.equal(row.adset_id, "120249626000270743");
  assert.equal(row.created_at, "2026-10-20T09:15:00.000Z");
  assert.equal(row.form_name, "Villa form");
  assert.equal(row.raw_import_data.meta_lead_form.answers["which_community?"], "Palm Jumeirah");
  assert.equal(mapMetaLeadToRow(graphLead(LEAD, { platform: "fb" })).source, "fb");
  assert.throws(() => mapMetaLeadToRow({ id: "abc" }));
});

function fakeDb(initial = []) {
  const rows = initial.map((r) => ({ archived: false, ...r }));
  const events = new Map();
  const control = { queueFails: false };
  let nextId = 1;
  const builder = (table) => {
    const state = { op: "select", filters: [], payload: null };
    const matches = (r) => state.filters.every((f) => f(r));
    const run = () => {
      if (table === "meta_crm_stage_events") {
        if (control.queueFails) return { data: null, error: { code: "unavailable" } };
        const key = `${state.payload.lead_id}:${state.payload.crm_stage}`;
        if (!events.has(key)) events.set(key, state.payload);
        return { data: null, error: null };
      }
      if (table !== "leads") return { data: null, error: null };
      if (state.op === "insert") {
        if (state.payload.meta_leadgen_id && rows.some((r) => r.meta_leadgen_id === state.payload.meta_leadgen_id)) {
          return { data: null, error: { code: "23505" } };
        }
        const row = { id: `lead-${nextId++}`, archived: false, ...state.payload };
        rows.push(row);
        return { data: [row], error: null };
      }
      const hit = rows.filter(matches);
      if (state.op === "update") {
        if (state.payload.meta_leadgen_id && rows.some((r) => r.meta_leadgen_id === state.payload.meta_leadgen_id)) {
          return { data: null, error: { code: "23505" } };
        }
        hit.forEach((r) => Object.assign(r, state.payload));
      }
      return { data: hit, error: null };
    };
    const api = {
      select() { return api; },
      insert(p) { state.op = "insert"; state.payload = p; return api; },
      update(p) { state.op = "update"; state.payload = p; return api; },
      upsert(p) { state.op = "upsert"; state.payload = p; return api; },
      eq(k, v) { state.filters.push((r) => r[k] === v); return api; },
      is(k, v) { state.filters.push((r) => (r[k] ?? null) === v); return api; },
      in(k, vs) { state.filters.push((r) => vs.includes(r[k])); return api; },
      or(expr) {
        const parts = expr.split(",").map((p) => p.split(".eq."));
        state.filters.push((r) => parts.some(([k, v]) => r[k] === v));
        return api;
      },
      limit() { return api; },
      single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return api;
  };
  return { rows, events, control, from: builder };
}

test("store: insert, idempotent replay, and merge into an untagged contact", async () => {
  const db = fakeDb([{ id: "old-1", phone: "+971509999999", meta_leadgen_id: null, campaign_name: "kept" }]);
  const first = await storeMetaLead(db, mapMetaLeadToRow(graphLead()));
  assert.equal(first.outcome, "inserted");
  assert.equal((await storeMetaLead(db, mapMetaLeadToRow(graphLead()))).outcome, "duplicate");
  assert.equal(db.rows.filter((r) => r.meta_leadgen_id === LEAD).length, 1);

  const other = mapMetaLeadToRow(graphLead("2234567890123456", { field_data: [{ name: "phone_number", values: ["+971509999999"] }] }));
  const merged = await storeMetaLead(db, other);
  assert.equal(merged.outcome, "merged");
  const target = db.rows.find((r) => r.id === "old-1");
  assert.equal(target.meta_leadgen_id, "2234567890123456");
  assert.equal(target.campaign_name, "kept", "existing attribution is never overwritten");
  assert.equal(target.ad_name, "Static-2", "empty attribution is filled");
});

test("store: merged leads keep the form answers; contact values cannot inject filters", async () => {
  const db = fakeDb([
    { id: "keep-1", email: "owner@villa.ae", meta_leadgen_id: null, raw_import_data: { excel_row: 7 } },
    { id: "victim", phone: "+971507777777", meta_leadgen_id: null },
  ]);
  const merged = await storeMetaLead(db, mapMetaLeadToRow(graphLead("6234567890123456", { field_data: [
    { name: "email", values: ["Owner@Villa.ae"] }, { name: "which_community?", values: ["Emirates Hills"] },
  ] })));
  assert.equal(merged.id, "keep-1");
  const kept = db.rows.find((r) => r.id === "keep-1").raw_import_data;
  assert.equal(kept.excel_row, 7, "existing import data is untouched");
  assert.equal(kept.meta_lead_form.answers["which_community?"], "Emirates Hills");

  const hostile = mapMetaLeadToRow(graphLead("7234567890123456", { field_data: [
    { name: "email", values: ["x,phone.not.is.null,email.eq.a@b.com"] },
  ] }));
  assert.equal(hostile.email, null, "filter punctuation is rejected at mapping");
  const forced = { ...hostile, email: "x,phone.not.is.null,email.eq.a@b.com" };
  const result = await storeMetaLead(db, forced);
  assert.equal(result.outcome, "inserted", "even a raw hostile value only ever matches by exact equality");
  assert.equal(db.rows.find((r) => r.id === "victim").meta_leadgen_id, null);
});

test("store: an archived contact is never revived silently; a new active lead is inserted", async () => {
  const db = fakeDb([{ id: "arch-1", phone: "+971508888888", meta_leadgen_id: null, archived: true }]);
  const row = mapMetaLeadToRow(graphLead("5234567890123456", { field_data: [{ name: "phone_number", values: ["+971508888888"] }] }));
  const result = await storeMetaLead(db, row);
  assert.equal(result.outcome, "inserted");
  assert.equal(db.rows.find((r) => r.id === "arch-1").meta_leadgen_id, null);
  assert.equal(db.rows.find((r) => r.id === result.id).archived, false);
});

test("pull: a lost Lead event is repaired on the next run; pagination never truncates silently", async () => {
  const db = fakeDb();
  const graph = {
    [`${PAGE}/leadgen_forms`]: { data: [{ id: "998877665544", name: "Villa form" }] },
    ["998877665544/leads"]: { data: [graphLead()] },
  };
  const fakeFetch = async (url) => ({ ok: true, json: async () => graph[url.pathname.split("/").slice(2).join("/")] ?? { data: [] } });
  const opts = { version: "v22.0", token: "t", pageIds: [PAGE], sinceSeconds: 1, execute: true, nowMs: NOW };
  db.control.queueFails = true;
  const first = await pullMetaLeads(db, fakeFetch, opts);
  assert.equal(first.failed, 1, "a lead stored without its event is a failure, not a success");
  assert.equal(db.events.size, 0);
  db.control.queueFails = false;
  const second = await pullMetaLeads(db, fakeFetch, opts);
  assert.deepEqual([second.already_in_crm, second.failed, db.events.size], [1, 0, 1]);

  let calls = 0;
  const endless = async () => { calls++; return { ok: true, json: async () => ({ data: [], paging: { next: "https://graph.facebook.com/v22.0/x?after=1" } }) }; };
  await assert.rejects(pullMetaLeads(fakeDb(), endless, { ...opts, execute: false }), /pagination_limit_reached/);
  assert.ok(calls >= 500);
});

test("pull: dry run reconciles per day without writing; execute fills the gap once", async () => {
  const db = fakeDb([{ id: "x", meta_leadgen_id: LEAD }]);
  const graph = {
    [`${PAGE}/leadgen_forms`]: { data: [{ id: "998877665544", name: "Villa form" }] },
    ["998877665544/leads"]: { data: [graphLead(), graphLead("3234567890123456", { field_data: [] })] },
  };
  const fakeFetch = async (url, init) => {
    assert.match(init.headers.Authorization, /^Bearer /);
    assert.equal(url.searchParams.get("access_token"), null, "token never in the URL");
    const key = url.pathname.split("/").slice(2).join("/");
    return { ok: true, json: async () => graph[key] ?? { data: [] } };
  };
  const opts = { version: "v22.0", token: "t", pageIds: [PAGE], sinceSeconds: 1, nowMs: NOW };
  const dry = await pullMetaLeads(db, fakeFetch, opts);
  assert.deepEqual([dry.meta_leads, dry.already_in_crm, dry.missing, dry.inserted], [2, 1, 1, 0]);
  assert.deepEqual(dry.by_day["2026-10-20"], { meta: 2, crm_before: 1 });
  assert.deepEqual(dry.by_hour_dubai, { "13": 2 }, "09:15 UTC is 13:15 in Dubai");
  assert.equal(db.rows.length, 1);
  const run = await pullMetaLeads(db, fakeFetch, { ...opts, execute: true });
  assert.equal(run.inserted, 1);
  const again = await pullMetaLeads(db, fakeFetch, { ...opts, execute: true });
  assert.deepEqual([again.missing, again.inserted], [0, 0]);
  assert.ok(!JSON.stringify(run).includes("Test Person"), "summary carries no customer data");
});

test("backfill: leads older than the sender's age limit are stored but never reported as queued", async () => {
  const db = fakeDb();
  const old = graphLead("8234567890123456", { created_time: "2026-09-25T10:00:00+0000" });
  const graph = {
    [`${PAGE}/leadgen_forms`]: { data: [{ id: "998877665544", name: "Villa form" }] },
    ["998877665544/leads"]: { data: [old, graphLead()] },
  };
  const fakeFetch = async (url) => ({ ok: true, json: async () => graph[url.pathname.split("/").slice(2).join("/")] ?? { data: [] } });
  const run = await pullMetaLeads(db, fakeFetch, { version: "v22.0", token: "t", pageIds: [PAGE], sinceSeconds: 1, execute: true, nowMs: NOW });
  assert.deepEqual([run.inserted, run.event_too_old, run.failed], [2, 1, 0]);
  assert.equal(db.events.size, 1, "only the deliverable Lead event is queued");
  const again = await pullMetaLeads(db, fakeFetch, { version: "v22.0", token: "t", pageIds: [PAGE], sinceSeconds: 1, execute: true, nowMs: NOW });
  assert.deepEqual([again.failed, db.events.size], [0, 1]);
});

const require = createRequire(import.meta.url);
function loadRoute(file, mocks) {
  const ts = require("typescript");
  const output = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}

test("webhook route: fails closed, verifies challenge and signature, stores once and queues Lead", async () => {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  Date.now = () => NOW;
  const db = fakeDb();
  const queued = [];
  let failQueue = false;
  const lib = await import("../../src/lib/meta-lead-ads.mjs");
  const route = loadRoute("../../src/app/api/meta/leadgen-webhook/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/supabase-admin": { supabaseAdmin: db },
    "@/lib/meta-crm-events": { enqueueMetaCrmStageEvent: async (_db, lead, stage) => {
      if (failQueue) return "skipped";
      queued.push([lead.meta_leadgen_id, stage]); return "queued";
    } },
    "@/lib/meta-lead-ads.mjs": lib,
  });
  try {
    delete process.env.META_LEADGEN_ENABLED;
    assert.equal((await route.POST(new Request("https://example.test", { method: "POST" }))).status, 503);
    Object.assign(process.env, { META_LEADGEN_ENABLED: "true", META_LEADGEN_VERIFY_TOKEN: "verify",
      META_APP_SECRET: "secret", META_LEADS_ACCESS_TOKEN: "token", META_LEADGEN_PAGE_IDS: PAGE });
    assert.equal(await (await route.GET(new Request("https://example.test?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42"))).text(), "42");
    assert.equal((await route.GET(new Request("https://example.test?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"))).status, 403);
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer token");
      assert.equal(new URL(url).searchParams.get("access_token"), null);
      return { ok: true, json: async () => graphLead() };
    };
    const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, changes: [{ field: "leadgen", value: { page_id: PAGE, leadgen_id: LEAD } }] }] });
    const post = (sig) => new Request("https://example.test", { method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw });
    assert.equal((await route.POST(post("sha256=" + "0".repeat(64)))).status, 403);
    assert.equal(db.rows.length, 0);
    failQueue = true;
    assert.equal((await route.POST(post(sign(raw, "secret")))).status, 503, "a lost Lead event asks Meta to retry");
    assert.equal(db.rows.length, 1);
    failQueue = false;
    const ok = await route.POST(post(sign(raw, "secret")));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).duplicate, 1);
    assert.equal(db.rows.length, 1, "Meta retries are idempotent");
    assert.deepEqual(queued, [[LEAD, "new"]], "the retry repaired the lost event");
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 190 } }) });
    const other = raw.replace(LEAD, "4234567890123456");
    assert.equal((await route.POST(new Request("https://example.test", { method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(other, "secret") }, body: other }))).status, 503,
      "a Graph failure asks Meta to retry");
  } finally {
    process.env = saved;
    globalThis.fetch = savedFetch;
    Date.now = savedNow;
  }
});
