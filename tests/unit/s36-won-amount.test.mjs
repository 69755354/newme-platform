// S36 B10: a lead can only be marked won with an amount. The amount is the active contract's, else the latest live
// quotation's (else the lead's stored quotation_value), else one entered at that moment. The Won / Purchase events to Meta
// carry that same amount, also when there is no active contract.
import assert from "node:assert/strict";
import test from "node:test";
import { ensureWonAmount, parseEnteredAmount, wonAmountForLead } from "../../src/lib/won-amount.mjs";
import { sendMetaCrmEvents } from "../../scripts/meta-crm-events-send.mjs";
import { enqueueWhatsAppPurchaseForLead } from "../../src/lib/whatsapp-capi.mjs";
import { enqueueWebsiteValuedEvent } from "../../src/lib/website-capi-valued.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");

// Tiny in-memory database: contracts, quotations and one lead row.
function fakeDb({ contracts = [], quotations = [], lead = { quotation_value: null, final_status: "won", ctwa_clid: "AfcT3sTcLiCkId_abc-123XYZ", phone: "0501234567" } } = {}) {
  const writes = [];
  const from = (table) => {
    let patch = null;
    const q = {
      select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q, is: () => q, in: () => q, gte: () => q, lt: () => q,
      insert: () => q,
      update: (p) => { patch = p; return q; },
      upsert: () => q,
      maybeSingle: async () => {
        if (table === "leads") return { data: lead, error: null };
        if (table === "whatsapp_conversations") return { data: { waba_id: "987654321" }, error: null };
        return { data: { id: "x" }, error: null };
      },
      then: (res, rej) => {
        if (patch) { writes.push([table, patch]); if (table === "leads") Object.assign(lead, patch); return Promise.resolve({ error: null }).then(res, rej); }
        const rows = table === "contracts" ? contracts : table === "quotations" ? quotations : [];
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return q;
  };
  return { from, writes, lead };
}

test("the won amount is the active contract's, else the latest live quotation's, else the lead's stored value", async () => {
  const contract = [{ contract_amount: 90000, currency: "aed" }];
  const quotes = [{ total_amount: 70000, currency: "AED" }];
  assert.deepEqual(await wonAmountForLead(fakeDb({ contracts: contract, quotations: quotes }), "l"), { value: 90000, currency: "AED" });
  assert.deepEqual(await wonAmountForLead(fakeDb({ quotations: quotes }), "l"), { value: 70000, currency: "AED" });
  assert.deepEqual(await wonAmountForLead(fakeDb({ lead: { quotation_value: 12000 } }), "l"), { value: 12000, currency: "AED" });
  assert.equal(await wonAmountForLead(fakeDb({ lead: { quotation_value: null } }), "l"), null);
  assert.equal(await wonAmountForLead(fakeDb({ lead: { quotation_value: 0 } }), "l"), null);
});

test("an entered amount must be a positive number that fits the column", () => {
  assert.equal(parseEnteredAmount(250000), 250000);
  assert.equal(parseEnteredAmount("1,250.5"), 1250.5);
  assert.equal(parseEnteredAmount(" 99 "), 99);
  for (const bad of [0, -1, "", "abc", null, undefined, NaN, Infinity, 1e10, "12abc", {}, []]) assert.equal(parseEnteredAmount(bad), null, String(bad));
});

test("marking won without any amount is refused; with an entered amount it is stored first", async () => {
  const none = fakeDb({ lead: { quotation_value: null } });
  const refused = await ensureWonAmount(none, "l", undefined);
  assert.deepEqual([refused.ok, refused.code], [false, "won_amount_required"]);
  assert.deepEqual(none.writes, []);
  const zero = await ensureWonAmount(none, "l", 0);
  assert.equal(zero.ok, false);

  const entered = await ensureWonAmount(none, "l", "180000");
  assert.equal(entered.ok, true);
  assert.equal(entered.wrote, true);
  assert.deepEqual(none.writes, [["leads", { quotation_value: 180000 }]]);

  const known = fakeDb({ quotations: [{ total_amount: 70000, currency: "AED" }] });
  const ok = await ensureWonAmount(known, "l", 5);
  assert.deepEqual([ok.ok, ok.wrote, ok.amount.value], [true, false, 70000]);
  assert.deepEqual(known.writes, [], "an amount that already exists is never overwritten by a typed one");
});

test("CRM Won carries the latest quotation amount when there is no active contract", async () => {
  const row = { id: "r1", lead_id: "l1", meta_leadgen_id: "123456789012345", event_name: "Won", event_time: NOW / 1000 - 60, status: "pending", attempts: 0 };
  const db = fakeDb({ quotations: [{ total_amount: 70000, currency: "AED" }] });
  // the sender reads the queue rows through the same fake: serve them for the queue table
  const base = db.from;
  db.from = (table) => {
    if (table !== "meta_crm_stage_events") return base(table);
    let patch = null;
    const q = { select: () => q, order: () => q, limit: () => q, lt: () => q, eq: () => q, in: () => q, gte: () => q,
      update: (p) => { patch = p; return q; }, maybeSingle: async () => ({ data: { id: "r1" }, error: null }),
      then: (res, rej) => Promise.resolve(patch ? { error: null } : { data: [row], error: null }).then(res, rej) };
    return q;
  };
  const sent = [];
  await sendMetaCrmEvents(db, { execute: true, clock: () => NOW, send: async (p) => sent.push(p), env: {} });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].data[0].custom_data.value, sent[0].data[0].custom_data.currency], [70000, "AED"]);
});

test("WhatsApp Purchase is sent with the quotation amount when the won lead has no active contract", async () => {
  const db = fakeDb({ quotations: [{ total_amount: 70000, currency: "AED" }] });
  const upserts = [];
  const base = db.from;
  db.from = (table) => {
    const q = base(table);
    if (table === "whatsapp_capi_events") q.upsert = (r) => { upserts.push(r); return q; };
    return q;
  };
  assert.equal(await enqueueWhatsAppPurchaseForLead(db, "l1"), "queued");
  assert.deepEqual([upserts[0].event_name, upserts[0].value, upserts[0].currency], ["Purchase", 70000, "AED"]);
  const empty = fakeDb({ lead: { final_status: "won", quotation_value: null, ctwa_clid: "AfcT3sTcLiCkId_abc-123XYZ" } });
  assert.equal(await enqueueWhatsAppPurchaseForLead(empty, "l1"), "skipped", "no amount at all: nothing is sent");
});

test("website Purchase is sent with the quotation amount when the won lead has no active contract", async () => {
  const h = (c) => c.repeat(64);
  const stored = { external_id: [h("a")], em: [h("b")], ph: [h("c")], fn: [h("d")], fbc: "fb.1.1.abc", fbp: "fb.1.1.def" };
  const lead = { final_status: "won", quotation_value: null, raw_import_data: { intake: "newme.ae", event_id: "evt1", capi_payload: { data: [{ user_data: stored }] } } };
  const db = fakeDb({ lead, quotations: [{ total_amount: 70000, currency: "AED" }] });
  const sent = [];
  const out = await enqueueWebsiteValuedEvent(db, "l1", "purchase", { attempt: async (_d, r) => sent.push(r.event_data.payload), nowSeconds: NOW / 1000 });
  assert.equal(out, "queued");
  assert.equal(sent[0].data[0].custom_data.value, 70000);
});

test("review P3-3: the quoted amount ignores non-AED quotations, like the database trigger", async () => {
  const { latestQuotationAmount } = await import("../../src/lib/quote-amount.mjs");
  const db = (quotes, reported = null) => ({ from: (table) => { const q = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: { quotation_value: reported }, error: null }),
    then: (res, rej) => Promise.resolve({ data: table === "quotations" ? quotes : null, error: null }).then(res, rej) }; return q; } });
  assert.equal(await latestQuotationAmount(db([{ total_amount: 5000, currency: "USD" }]), "l"), null);
  assert.deepEqual(await latestQuotationAmount(db([{ total_amount: 5000, currency: "USD" }, { total_amount: 900, currency: "AED" }]), "l"), { value: 900, currency: "AED" });
  assert.deepEqual(await latestQuotationAmount(db([{ total_amount: 7, currency: null }]), "l"), { value: 7, currency: "AED" });
  assert.deepEqual(await latestQuotationAmount(db([{ total_amount: 5000, currency: "USD" }], 300), "l"), { value: 300, currency: "AED" });
});
