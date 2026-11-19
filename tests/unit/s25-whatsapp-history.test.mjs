import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { HISTORY_BATCH, extractWhatsAppHistory, hasHistorySyncFields, historySyncEnabled, recordWhatsAppHistory } from "../../src/lib/whatsapp-history.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const channel = { id: "channel-intake", phone_number_id: "123456789", waba_id: "987654321", business_phone: "15551234567", enabled: true, accept_since: "2026-11-19T00:00:00.000Z" };
const now = Date.parse("2026-11-19T12:00:00Z");
const seconds = (time) => String(Date.parse(time) / 1000);
const metadata = { phone_number_id: channel.phone_number_id, display_phone_number: channel.business_phone };
const historyBody = (chunks) => ({ object: "whatsapp_business_account", entry: [{ id: channel.waba_id, changes: [{ field: "history", value: { messaging_product: "whatsapp", metadata, history: chunks } }] }] });
const chunk = (threads, meta = { phase: 0, chunk_order: 1, progress: 10 }) => ({ metadata: meta, threads });
const customerMsg = (id, time, body = "PRIVATE HELLO") => ({ id, from: "971501234567", timestamp: seconds(time), type: "text", text: { body }, history_context: { status: "READ" } });
const staffMsg = (id, time, body = "STAFF REPLY") => ({ id, from: channel.business_phone, timestamp: seconds(time), type: "text", text: { body }, history_context: { status: "DELIVERED" } });
const contactsBody = (items) => ({ object: "whatsapp_business_account", entry: [{ id: channel.waba_id, changes: [{ field: "smb_app_state_sync", value: { messaging_product: "whatsapp", metadata, state_sync: items } }] }] });

test("history messages become customer/staff events with payload timestamps and S21 text storage", () => {
  const parsed = extractWhatsAppHistory(historyBody([chunk([{ id: "971501234567", messages: [
    customerMsg("wamid.h1", "2026-06-01T08:00:00Z"), staffMsg("wamid.h2", "2026-06-01T08:05:00Z"),
    { id: "wamid.h3", from: "971501234567", timestamp: seconds("2026-06-01T08:06:00Z"), type: "image", image: { id: "m", caption: "SECRET" } },
  ] }])]), [channel], now);
  assert.equal(parsed.messages.length, 3);
  const [a, b, c] = parsed.messages;
  assert.deepEqual([a.direction, a.occurred_at, a.body, a.body_kind, a.customer_phone], ["inbound", "2026-06-01T08:00:00.000Z", "PRIVATE HELLO", "text", "971501234567"]);
  assert.deepEqual([b.direction, b.body, b.customer_phone], ["outbound", "STAFF REPLY", "971501234567"]);
  assert.deepEqual([c.body, c.body_kind], [null, "media"]);
  assert.deepEqual(parsed.chunks, [{ phase: 0, chunk_order: 1, progress: 10 }]);
  assert.equal(JSON.stringify(parsed).includes("SECRET"), false);
});

test("history is not limited by accept_since or the 30 day live window, but must be sane and from an approved channel", () => {
  const old = extractWhatsAppHistory(historyBody([chunk([{ id: "971501234567", messages: [
    customerMsg("wamid.old", "2026-05-25T00:00:00Z"),
    customerMsg("wamid.toooold", "2025-01-01T00:00:00Z"),
    customerMsg("wamid.future", "2026-11-25T00:00:00Z"),
  ] }])]), [channel], now);
  assert.deepEqual(old.messages.map((m) => m.message_id), ["wamid.old"]);
  assert.equal(extractWhatsAppHistory(historyBody([chunk([{ id: "971501234567", messages: [customerMsg("x", "2026-06-01T00:00:00Z")] }])]), [{ ...channel, enabled: false }], now).messages.length, 0);
  assert.equal(extractWhatsAppHistory(historyBody([chunk([{ id: "971501234567", messages: [customerMsg("x", "2026-06-01T00:00:00Z")] }])]), [{ ...channel, waba_id: "111111111" }], now).messages.length, 0);
});

test("duplicates inside one body, unsupported kinds, group-like ids and declined syncs are handled", () => {
  const parsed = extractWhatsAppHistory(historyBody([
    chunk([{ id: "971501234567", messages: [customerMsg("wamid.d", "2026-06-01T08:00:00Z"), customerMsg("wamid.d", "2026-06-01T08:00:00Z"),
      { id: "wamid.u", from: "971501234567", timestamp: seconds("2026-06-01T08:00:00Z"), type: "unsupported" }] }]),
    chunk([{ id: "120363000000000000@g.us", messages: [{ ...customerMsg("wamid.g", "2026-06-01T08:00:00Z"), from: "not-a-phone" }] }]),
    { errors: [{ code: 2593109, title: "history sync declined" }] },
  ]), [channel], now);
  assert.deepEqual(parsed.messages.map((m) => m.message_id), ["wamid.d"]);
  assert.equal(parsed.declined, 1);
});

test("smb_app_state_sync contacts are parsed with normalised numbers; remove is kept as a remove", () => {
  const parsed = extractWhatsAppHistory(contactsBody([
    { type: "contact", contact: { full_name: "Aisha Khan", first_name: "Aisha", phone_number: "+971 50 123 4567" }, action: "add", metadata: { timestamp: "1700000000" } },
    { type: "contact", contact: { full_name: "Old Name", phone_number: "971509999999" }, action: "remove" },
    { type: "contact", contact: { full_name: "No Number" }, action: "add" },
    { type: "other", contact: { phone_number: "971501111111" } },
  ]), [channel], now);
  assert.equal(parsed.messages.length, 0);
  assert.deepEqual(parsed.contacts.map((c) => [c.phone, c.full_name, c.action]), [["971501234567", "Aisha Khan", "add"], ["971509999999", "Old Name", "remove"]]);
});

test("hasHistorySyncFields only reacts to the two sync fields and the switch can be turned off", () => {
  assert.equal(hasHistorySyncFields(historyBody([])), true);
  assert.equal(hasHistorySyncFields(contactsBody([])), true);
  assert.equal(hasHistorySyncFields({ entry: [{ changes: [{ field: "messages" }] }] }), false);
  assert.equal(hasHistorySyncFields(null), false);
  assert.equal(historySyncEnabled({}), true);
  assert.equal(historySyncEnabled({ WHATSAPP_HISTORY_SYNC_ENABLED: "false" }), false);
});

/** In-memory model of the two history routines: dedupe on (waba, message id), nothing else is ever written. */
function fakeDb() {
  const events = new Map();
  const contacts = new Map();
  const rpcNames = [];
  return {
    events, contacts, rpcNames,
    async rpc(name, args) {
      rpcNames.push(name);
      if (name === "record_whatsapp_history_messages") {
        let inserted = 0, duplicate = 0;
        for (const e of args.p_events) {
          const key = `${e.waba_id}:${e.message_id}`;
          if (events.has(key)) duplicate++; else { events.set(key, { ...e, backfilled: true }); inserted++; }
        }
        return { data: { inserted, duplicate, rejected: 0 }, error: null };
      }
      if (name === "record_whatsapp_synced_contacts") {
        for (const c of args.p_contacts) contacts.set(`${c.waba_id}:${c.phone}`, c);
        return { data: { upserted: args.p_contacts.length, removed: 0, rejected: 0 }, error: null };
      }
      return { data: null, error: { message: "unexpected rpc" } };
    },
  };
}

test("replaying the same history is idempotent (dedupe on message id)", async () => {
  const body = historyBody([chunk([{ id: "971501234567", messages: [customerMsg("wamid.1", "2026-06-01T08:00:00Z"), staffMsg("wamid.2", "2026-06-01T08:01:00Z")] }])]);
  const db = fakeDb();
  const first = await recordWhatsAppHistory(db, extractWhatsAppHistory(body, [channel], now));
  const second = await recordWhatsAppHistory(db, extractWhatsAppHistory(body, [channel], now));
  assert.deepEqual([first.inserted, first.duplicate, first.failed], [2, 0, 0]);
  assert.deepEqual([second.inserted, second.duplicate, second.failed], [0, 2, 0]);
  assert.equal(db.events.size, 2);
});

test("history has no lead, Meta feedback or alert side effects: it only calls the two history-only routines", async () => {
  const db = fakeDb();
  const parsed = extractWhatsAppHistory(historyBody([chunk([{ id: "971501234567", messages: [customerMsg("wamid.1", "2026-06-01T08:00:00Z")] }])]), [channel], now);
  await recordWhatsAppHistory(db, { ...parsed, contacts: [{ waba_id: "987654321", phone_number_id: "123456789", phone: "971501234567", full_name: "A", first_name: null, action: "add" }] });
  assert.deepEqual([...new Set(db.rpcNames)].sort(), ["record_whatsapp_history_messages", "record_whatsapp_synced_contacts"]);
  for (const event of db.events.values()) {
    assert.equal(event.backfilled, true);
    assert.equal("referral" in event, false);
    assert.equal("source" in event, false);
  }
  // Source-level guarantees: the library never touches the live writer, the Meta queue or leads.
  const lib = read("src/lib/whatsapp-history.mjs").replace(/\/\/.*$/gm, "");
  for (const forbidden of ["record_whatsapp_ad_event", "whatsapp_capi_events", "graph.facebook", "fetch(", ".from(\"leads\")", "referral", "ctwa_clid"]) assert.equal(lib.includes(forbidden), false, forbidden);
  // SQL: the history writer inserts events (and an empty conversation) only.
  const sql = read("supabase/migrations/20261119150000_whatsapp_history_backfill.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const fn = sql.slice(sql.indexOf("function public.record_whatsapp_history_messages"), sql.indexOf("function public.record_whatsapp_synced_contacts"));
  assert.match(fn, /insert into public\.whatsapp_message_events/);
  assert.match(fn, /true\)\s*on conflict \(waba_id, message_id\) do nothing/);
  for (const forbidden of ["public.leads", "whatsapp_capi_events", "update public.whatsapp_conversations", "referral_ctwa_clid", "notifications"]) assert.equal(fn.includes(forbidden), false, forbidden);
  const contactsFn = sql.slice(sql.indexOf("function public.record_whatsapp_synced_contacts"));
  for (const forbidden of ["public.leads", "whatsapp_capi_events", "whatsapp_message_events"]) assert.equal(contactsFn.includes(forbidden), false, forbidden);
});

test("large histories are written in batches and a failed batch is reported so the route answers 503", async () => {
  const messages = Array.from({ length: HISTORY_BATCH * 2 + 1 }, (_, i) => ({ waba_id: "987654321", phone_number_id: "123456789", customer_phone: "971501234567", direction: "inbound", message_id: `m${i}`, message_type: "text", body: "x", body_kind: "text", occurred_at: "2026-06-01T08:00:00.000Z" }));
  let calls = 0;
  const db = { async rpc() { calls++; return calls === 2 ? { data: null, error: { message: "boom" } } : { data: { inserted: HISTORY_BATCH, duplicate: 0, rejected: 0 }, error: null }; } };
  const summary = await recordWhatsAppHistory(db, { messages, contacts: [] });
  assert.equal(calls, 3);
  assert.equal(summary.failed, 1);
});

test("the webhook routes history only after the live paths, the monitor ignores backfilled rows and the live writer is untouched", () => {
  const route = read("src/app/api/whatsapp/webhook/route.ts");
  assert.ok(route.indexOf("await recordWhatsAppHistory(") > route.indexOf("await recordWhatsAppAdEvents("));
  assert.match(route, /history_write_failed/);
  assert.match(read("src/app/api/cron/check-whatsapp-followups/route.ts"), /\.eq\("backfilled", false\)/);
  assert.match(read("src/app/api/meta/whatsapp-webhook/route.ts"), /whatsapp\/webhook\/route/);
  assert.equal(read("supabase/migrations/20261119150000_whatsapp_history_backfill.sql").includes("create or replace function public.record_whatsapp_ad_event"), false);
  assert.match(read("supabase/migrations/20261119150000_whatsapp_history_backfill.sql"), /add column if not exists backfilled boolean not null default false/);
});

const require = createRequire(import.meta.url);
function loadRoute(mocks) {
  const ts = require("typescript");
  const output = ts.transpileModule(read("src/app/api/whatsapp/webhook/route.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}

test("route level: a history delivery stores backfilled rows only and calls neither the live writer nor the pilot table", async () => {
  const saved = { ...process.env };
  const calls = [];
  const admin = {
    from: (table) => ({ select: () => ({ eq: async () => ({ data: [channel], error: null }) }), upsert: async () => { calls.push(`upsert:${table}`); return { error: null }; } }),
    rpc: async (name) => { calls.push(name); return { data: { inserted: 1, duplicate: 0, rejected: 0, upserted: 1, removed: 0 }, error: null }; },
  };
  const route = loadRoute({ "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } }, "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/whatsapp-pilot.mjs": require("../../src/lib/whatsapp-pilot.mjs"), "@/lib/whatsapp-ctwa.mjs": require("../../src/lib/whatsapp-ctwa.mjs"),
    "@/lib/whatsapp-ctwa-ingest.mjs": require("../../src/lib/whatsapp-ctwa-ingest.mjs"), "@/lib/whatsapp-history.mjs": require("../../src/lib/whatsapp-history.mjs") });
  Object.assign(process.env, { WHATSAPP_PILOT_ENABLED: "true", WHATSAPP_APP_SECRET: "secret", WHATSAPP_PILOT_CONTACT_SALT: "salt" });
  const send = async (payload) => {
    const raw = JSON.stringify(payload);
    return route.POST(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}` }, body: raw }));
  };
  try {
    const realNow = Date.now;
    const history = historyBody([chunk([{ id: "971501234567", messages: [customerMsg("wamid.1", new Date(realNow() - 86_400_000 * 90).toISOString())] }])]);
    assert.equal((await send(history)).status, 200);
    assert.deepEqual(calls, ["record_whatsapp_history_messages"]);
    calls.length = 0;
    assert.equal((await send(contactsBody([{ type: "contact", contact: { full_name: "A", phone_number: "971501234567" }, action: "add" }]))).status, 200);
    assert.deepEqual(calls, ["record_whatsapp_synced_contacts"]);
    calls.length = 0;
    process.env.WHATSAPP_HISTORY_SYNC_ENABLED = "false";
    assert.equal((await send(history)).status, 200);
    assert.deepEqual(calls, []);
    delete process.env.WHATSAPP_HISTORY_SYNC_ENABLED;
    admin.rpc = async () => ({ data: null, error: { message: "down" } });
    assert.equal((await send(history)).status, 503);
  } finally { process.env = saved; }
});
