import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWhatsAppCapiPayload, sendWhatsAppCapiPayload, enqueueWhatsAppCapiEvent, enqueueWhatsAppCapiForProgress,
  enqueueWhatsAppCapiForQuality, enqueueWhatsAppPurchaseForLead, enqueueWhatsAppPurchaseForContract, WA_STAGE_EVENTS,
} from "../../src/lib/whatsapp-capi.mjs";
import { recordWhatsAppAdEvents } from "../../src/lib/whatsapp-ctwa-ingest.mjs";

const CLID = "AfcT3sTcLiCkId_abc-123XYZ";
const LEAD = "11111111-1111-4111-8111-111111111111";

// A small in-memory stand-in for the PostgREST client: eq filters, order, limit, upsert with ignoreDuplicates.
function fakeDb(seed = {}) {
  const tables = { leads: [], whatsapp_conversations: [], whatsapp_capi_events: [], contracts: [], quotations: [], ...seed };
  const from = (name) => {
    let rows = tables[name] ?? [];
    const q = {
      select: () => q,
      eq: (col, val) => { rows = rows.filter((r) => r[col] === val); return q; },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      upsert: async (row, options) => {
        const keys = options.onConflict.split(",");
        const exists = tables[name].some((r) => keys.every((k) => r[k] === row[k]));
        if (!exists) tables[name].push({ ...row });
        else if (!options.ignoreDuplicates) Object.assign(tables[name].find((r) => keys.every((k) => r[k] === row[k])), row);
        return { error: null };
      },
    };
    return q;
  };
  return { tables, from };
}
const seeded = (extra = {}) => fakeDb({
  leads: [{ id: LEAD, ctwa_clid: CLID, final_status: null }],
  whatsapp_conversations: [{ lead_id: LEAD, first_ctwa_clid: CLID, waba_id: "987654321" }],
  ...extra,
});

test("payload follows the business-messaging contract", () => {
  const { data: [event] } = buildWhatsAppCapiPayload({ eventId: "e1", wabaId: "987654321", ctwaClid: CLID, eventName: "LeadSubmitted", eventTime: 1795000000 });
  assert.deepEqual(event, {
    event_name: "LeadSubmitted", event_time: 1795000000, action_source: "business_messaging", messaging_channel: "whatsapp",
    user_data: { whatsapp_business_account_id: "987654321", ctwa_clid: CLID }, event_id: "e1",
  });
  const purchase = buildWhatsAppCapiPayload({ wabaId: "987654321", ctwaClid: CLID, eventName: "Purchase", eventTime: 1795000000, value: 12500.5, currency: "AED" }).data[0];
  assert.deepEqual(purchase.custom_data, { currency: "AED", value: 12500.5 });
  assert.equal("custom_data" in event, false);
});

test("payload refuses a bad event name, waba, click id, time and a Purchase without value or currency", () => {
  const ok = { wabaId: "987654321", ctwaClid: CLID, eventName: "QualifiedLead", eventTime: 1795000000 };
  assert.doesNotThrow(() => buildWhatsAppCapiPayload(ok));
  for (const bad of [{ eventName: "Lead" }, { wabaId: "abc" }, { ctwaClid: "bad id" }, { eventTime: 0 }, { eventTime: 1.5 }, { eventName: "Purchase" }, { eventName: "Purchase", value: 10 }, { eventName: "Purchase", value: -1, currency: "AED" }]) {
    assert.throws(() => buildWhatsAppCapiPayload({ ...ok, ...bad }), undefined, JSON.stringify(bad));
  }
});

test("sender posts to /{dataset}/events with the bearer token and checks the receipt; no dataset means it does not send", async () => {
  const payload = buildWhatsAppCapiPayload({ wabaId: "987654321", ctwaClid: CLID, eventName: "QualifiedLead", eventTime: 1795000000 });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, json: async () => ({ events_received: 1 }) }; };
  await sendWhatsAppCapiPayload(payload, { env: { META_WA_DATASET_ID: "5550001", META_CAPI_ACCESS_TOKEN: "tok", META_GRAPH_API_VERSION: "v25.0" }, fetchImpl });
  assert.equal(calls[0].url, "https://graph.facebook.com/v25.0/5550001/events");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(JSON.parse(calls[0].init.body).data[0].action_source, "business_messaging");
  assert.equal(calls[0].url.includes("tok"), false);
  await assert.rejects(sendWhatsAppCapiPayload(payload, { env: { META_CAPI_ACCESS_TOKEN: "tok" }, fetchImpl }), /configuration is unavailable/);
  assert.equal(calls.length, 1);
  await assert.rejects(sendWhatsAppCapiPayload(payload, { env: { META_WA_DATASET_ID: "5550001", META_CAPI_ACCESS_TOKEN: "tok" }, fetchImpl: async () => ({ ok: true, json: async () => ({ events_received: 0 }) }) }), /did not acknowledge/);
  await assert.rejects(sendWhatsAppCapiPayload(payload, { env: { META_WA_DATASET_ID: "5550001", META_CAPI_ACCESS_TOKEN: "tok" }, fetchImpl: async () => ({ ok: false, status: 400 }) }), /returned 400/);
});

test("stage progress queues QualifiedLead once; contacted and early stages queue nothing", async () => {
  const db = seeded();
  assert.equal(await enqueueWhatsAppCapiForProgress(db, LEAD, "contacted"), "skipped");
  assert.equal(await enqueueWhatsAppCapiForProgress(db, LEAD, "new"), "skipped");
  assert.equal(await enqueueWhatsAppCapiForProgress(db, LEAD, "requirement_confirmed"), "queued");
  await enqueueWhatsAppCapiForProgress(db, LEAD, "quotation_submitted");
  await enqueueWhatsAppCapiForProgress(db, LEAD, "requirements");
  assert.equal(db.tables.whatsapp_capi_events.length, 1);
  const [row] = db.tables.whatsapp_capi_events;
  assert.equal(row.event_name, "QualifiedLead"); assert.equal(row.waba_id, "987654321"); assert.equal(row.ctwa_clid, CLID);
  assert.ok(Number.isInteger(row.event_time) && row.event_time > 1_700_000_000);
  assert.deepEqual(Object.keys(WA_STAGE_EVENTS).filter((k) => WA_STAGE_EVENTS[k] !== "QualifiedLead"), []);
});

test("quality good or normal queues QualifiedLead; poor and pending do not", async () => {
  for (const [quality, expected] of [["good", 1], ["normal", 1], ["poor", 0], ["pending", 0]]) {
    const db = seeded();
    await enqueueWhatsAppCapiForQuality(db, LEAD, quality);
    assert.equal(db.tables.whatsapp_capi_events.length, expected, quality);
  }
});

test("a lead without a click id (form lead, organic WhatsApp lead) never queues a business-messaging event", async () => {
  const db = fakeDb({ leads: [{ id: LEAD, ctwa_clid: null }], whatsapp_conversations: [{ lead_id: LEAD, first_ctwa_clid: null, waba_id: "987654321" }] });
  assert.equal(await enqueueWhatsAppCapiForProgress(db, LEAD, "requirement_confirmed"), "skipped");
  assert.equal(await enqueueWhatsAppCapiForQuality(db, LEAD, "good"), "skipped");
  assert.equal(db.tables.whatsapp_capi_events.length, 0);
});

test("Purchase needs the lead won and the active contract's amount, and is queued once", async () => {
  const contract = { id: "c1", lead_id: LEAD, status: "active", contract_amount: 48000, currency: "AED", created_at: "2026-11-18" };
  const notWon = seeded({ contracts: [contract] });
  assert.equal(await enqueueWhatsAppPurchaseForLead(notWon, LEAD), "skipped");
  const won = seeded({ contracts: [contract] });
  won.tables.leads[0].final_status = "won";
  assert.equal(await enqueueWhatsAppPurchaseForContract(won, "c1"), "queued");
  assert.equal(await enqueueWhatsAppPurchaseForLead(won, LEAD), "queued");
  assert.equal(won.tables.whatsapp_capi_events.length, 1);
  assert.equal(won.tables.whatsapp_capi_events[0].value, 48000);
  assert.equal(won.tables.whatsapp_capi_events[0].currency, "AED");
  const noContract = seeded();
  noContract.tables.leads[0].final_status = "won";
  assert.equal(await enqueueWhatsAppPurchaseForLead(noContract, LEAD), "skipped");
});

test("enqueue never throws into the caller", async () => {
  const broken = { from: () => { throw new Error("db down"); } };
  assert.equal(await enqueueWhatsAppCapiForProgress(broken, LEAD, "requirement_confirmed"), "skipped");
  assert.equal(await enqueueWhatsAppPurchaseForContract(broken, "c1"), "skipped");
});

test("ingest counts new leads, duplicates and failures and never throws", async () => {
  const answers = [{ data: { lead_created: true, attributed: true, queued: true }, error: null }, { data: { duplicate: true }, error: null }, { data: null, error: { code: "x" } }];
  const seen = [];
  const db = { rpc: async (name, args) => { seen.push([name, args]); return answers.shift(); } };
  const summary = await recordWhatsAppAdEvents(db, [{ message_id: "a" }, { message_id: "b" }, { message_id: "c" }], { createOrganic: false });
  assert.deepEqual(summary, { recorded: 2, duplicate: 1, leads_created: 1, attributed: 1, queued: 1, failed: 1 });
  assert.equal(seen[0][0], "record_whatsapp_ad_event");
  assert.equal(seen[0][1].p_create_organic, false);
  const thrown = await recordWhatsAppAdEvents({ rpc: () => { throw new Error("boom"); } }, [{ message_id: "z" }]);
  assert.equal(thrown.failed, 1);
});

test("sender prefers the WhatsApp dataset's own key over the shared pixel key name", async () => {
  const payload = buildWhatsAppCapiPayload({ wabaId: "987654321", ctwaClid: CLID, eventName: "QualifiedLead", eventTime: 1795000000 });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init); return { ok: true, json: async () => ({ events_received: 1 }) }; };
  await sendWhatsAppCapiPayload(payload, { env: { META_WA_DATASET_ID: "5550001", META_WA_CAPI_ACCESS_TOKEN: "wa-tok", META_CAPI_ACCESS_TOKEN: "pixel-tok" }, fetchImpl });
  assert.equal(calls[0].headers.Authorization, "Bearer wa-tok");
});

test("S45: internal numbers are stored but never create a lead or carry a click id; empty list changes nothing", async () => {
  const { internalNumberKeys } = await import("../../src/lib/whatsapp-ctwa-ingest.mjs");
  const keys = internalNumberKeys({ NEWME_WA_INTERNAL_NUMBERS: " +971500000001 , 0500000002,,junk" });
  assert.deepEqual([...keys].sort(), ["971500000001", "971500000002"]);
  assert.equal(internalNumberKeys({}).size, 0);
  const ref = { source_type: "ad", source_id: "120210000000001", ctwa_clid: "AfcT3sTcLiCkId_abc-123XYZ" };
  const seen = [];
  const db = { rpc: async (_n, args) => { seen.push(args); return { data: { lead_created: false }, error: null }; } };
  const events = [{ message_id: "a", customer_phone: "971500000001", referral: ref }, { message_id: "b", customer_phone: "971500000099", referral: ref }];
  await recordWhatsAppAdEvents(db, events, { createOrganic: true, internalKeys: keys });
  assert.equal(seen[0].p_create_organic, false); assert.equal(seen[0].p_event.referral, null); assert.equal(seen[0].p_event.message_id, "a");
  assert.equal(seen[1].p_create_organic, true); assert.deepEqual(seen[1].p_event.referral, ref);
  seen.length = 0;
  await recordWhatsAppAdEvents(db, events, { createOrganic: true, internalKeys: new Set() });
  assert.deepEqual(seen.map((s) => s.p_create_organic), [true, true]);
});
