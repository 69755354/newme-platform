import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildMetaCrmPayload, hashedContactKeys } from "../../src/lib/meta-crm-events.ts";
import { sendMetaCrmEvents } from "../../scripts/meta-crm-events-send.mjs";
import { buildWebsiteValuedPayload, enqueueWebsiteValuedEvent } from "../../src/lib/website-capi-valued.mjs";
import { buildWhatsAppCapiPayload } from "../../src/lib/whatsapp-capi.mjs";
import { sendWhatsAppCapiEvents } from "../../scripts/whatsapp-capi-send.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const NOW = Date.parse("2026-11-20T12:00:00Z");

test("hashedContactKeys normalizes phone like the website path and rejects junk", () => {
  assert.deepEqual(hashedContactKeys({ phone: "050 123 4567", email: " A@B.com " }), { ph: [sha("971501234567")], em: [sha("a@b.com")] });
  assert.deepEqual(hashedContactKeys({ phone: "12", email: "nope" }), {});
});

test("Won carries value and currency; other events never do", () => {
  const won = buildMetaCrmPayload({ leadgenId: "123456789012345", eventName: "Won", eventTime: 1, value: 250000, currency: "AED",
    match: hashedContactKeys({ phone: "0501234567" }) });
  assert.deepEqual(won.data[0].custom_data, { lead_event_source: "crm", event_source: "crm", value: 250000, currency: "AED" });
  assert.deepEqual(won.data[0].user_data.ph, [sha("971501234567")]);
  const q = buildMetaCrmPayload({ leadgenId: "123456789012345", eventName: "Qualified", eventTime: 1, value: 5, currency: "AED" });
  assert.deepEqual(q.data[0].custom_data, { lead_event_source: "crm", event_source: "crm" });
  const bad = buildMetaCrmPayload({ leadgenId: "123456789012345", eventName: "Won", eventTime: 1, value: 0, currency: "aed" });
  assert.equal(bad.data[0].custom_data.value, undefined);
});

// Minimal db for the CRM sender: queue rows, contract and lead lookups.
function crmDb(row, { amount = 1000 } = {}) {
  const updates = [];
  const from = (table) => {
    let patch = null; let gte = false;
    const q = {
      select: () => q, order: () => q, limit: () => q, lt: () => q, eq: () => q, in: () => q,
      gte: () => { gte = true; return q; },
      update: (p) => { patch = p; updates.push(p); return q; },
      maybeSingle: async () => ({ data: table === "leads" ? { phone: "0501234567", email: null } : { id: row.id }, error: null }),
      then: (res, rej) => Promise.resolve(table === "contracts" ? { data: amount ? [{ contract_amount: amount, currency: "aed" }] : [], error: null }
        : patch ? { error: null } : { data: gte ? [] : [row], error: null }).then(res, rej),
    };
    return q;
  };
  return { from, updates };
}
const crmRow = { id: "r1", lead_id: "l1", meta_leadgen_id: "123456789012345", event_name: "Won", event_time: NOW / 1000 - 60, status: "pending", attempts: 0 };

test("CRM sender adds the contract amount to Won and hashed contact only when enabled", async () => {
  const sent = [];
  await sendMetaCrmEvents(crmDb(crmRow), { execute: true, clock: () => NOW, send: async (p) => sent.push(p), env: {} });
  assert.deepEqual(sent[0].data[0].custom_data.value, 1000);
  assert.equal(sent[0].data[0].custom_data.currency, "AED");
  assert.equal(sent[0].data[0].user_data.ph, undefined);
  await sendMetaCrmEvents(crmDb(crmRow), { execute: true, clock: () => NOW, send: async (p) => sent.push(p), env: { META_CRM_SEND_HASHED_CONTACT: "true" } });
  assert.deepEqual(sent[1].data[0].user_data.ph, [sha("971501234567")]);
  assert.equal(sent[1].data[0].user_data.lead_id, "123456789012345");
});

test("CRM Won without an active contract is still a plain Won", async () => {
  const sent = [];
  await sendMetaCrmEvents(crmDb(crmRow, { amount: 0 }), { execute: true, clock: () => NOW, send: async (p) => sent.push(p), env: {} });
  assert.equal(sent[0].data[0].custom_data.value, undefined);
});

const stored = { external_id: [sha("lead1")], em: [sha("a@b.com")], ph: [sha("971501234567")], fn: [sha("sam")],
  fbc: "fb.1.1.abc", fbp: "fb.1.1.def", client_ip_address: "1.2.3.4", client_user_agent: "UA" };

test("website Purchase reuses stored hashed matching keys, drops IP/UA, is deterministic", () => {
  const p = buildWebsiteValuedPayload({ kind: "purchase", leadEventId: "evt1", storedUserData: stored, value: 90000, currency: "AED", eventTime: 5 });
  const e = p.data[0];
  assert.equal(e.event_name, "Purchase"); assert.equal(e.event_id, "purchase:evt1"); assert.equal(e.action_source, "system_generated");
  assert.deepEqual(Object.keys(e.user_data).sort(), ["em", "external_id", "fbc", "fbp", "fn", "ph"]);
  assert.deepEqual(e.custom_data, { currency: "AED", value: 90000, lead_event_source: "website" });
  assert.throws(() => buildWebsiteValuedPayload({ kind: "purchase", leadEventId: "e", storedUserData: stored, value: 0, currency: "AED", eventTime: 1 }));
  assert.throws(() => buildWebsiteValuedPayload({ kind: "purchase", leadEventId: "e", storedUserData: {}, value: 1, currency: "AED", eventTime: 1 }));
});

function webDb({ lead, contracts = [{ contract_amount: 90000, currency: "AED" }], dup = false }) {
  const inserts = []; const updates = [];
  const from = (table) => {
    let patch = null;
    const q = {
      select: () => q, eq: () => q, order: () => q, limit: () => q,
      insert: (r) => { inserts.push(r); return q; },
      update: (p) => { patch = p; updates.push(p); return q; },
      maybeSingle: async () => table === "leads" ? { data: lead, error: null }
        : table === "business_events" ? (patch ? { data: { id: "x" }, error: null } : { data: dup ? null : { id: "x" }, error: dup ? { code: "23505" } : null })
        : { data: null, error: null },
      then: (res, rej) => Promise.resolve({ data: table === "contracts" ? contracts : null, error: null }).then(res, rej),
    };
    return q;
  };
  return { from, inserts, updates };
}
const websiteLead = { final_status: "won", raw_import_data: { intake: "newme.ae", event_id: "evt1", capi_payload: { data: [{ user_data: stored }] } } };

test("website lead won with a contract queues one Purchase and tries delivery", async () => {
  const db = webDb({ lead: websiteLead }); const sent = [];
  assert.equal(await enqueueWebsiteValuedEvent(db, "lead1", "purchase", { attempt: async (_d, row) => sent.push(row.event_data.payload), nowSeconds: NOW / 1000 }), "queued");
  assert.equal(db.inserts[0].event_type, "meta_capi_purchase_delivery");
  assert.equal(sent.length, 1); assert.equal(sent[0].data[0].custom_data.value, 90000);
});

test("website Purchase skips non-won, non-website, no contract and duplicates", async () => {
  const send = async () => assert.fail("must not send");
  assert.equal(await enqueueWebsiteValuedEvent(webDb({ lead: { ...websiteLead, final_status: "open" } }), "l", "purchase", {}), "skipped");
  assert.equal(await enqueueWebsiteValuedEvent(webDb({ lead: { final_status: "won", raw_import_data: { intake: "meta" } } }), "l", "purchase", {}), "skipped");
  assert.equal(await enqueueWebsiteValuedEvent(webDb({ lead: websiteLead, contracts: [] }), "l", "purchase", {}), "skipped");
  assert.equal(await enqueueWebsiteValuedEvent(webDb({ lead: websiteLead, dup: true }), "l", "purchase", {}), "skipped");
});

test("WhatsApp payload carries a hashed phone only when valid", () => {
  const base = { eventId: "e", wabaId: "123456", ctwaClid: "AfcT3sTcLiCkId_abc-123XYZ", eventName: "QualifiedLead", eventTime: 5 };
  assert.deepEqual(buildWhatsAppCapiPayload({ ...base, hashedPhone: [sha("971501234567")] }).data[0].user_data.ph, [sha("971501234567")]);
  assert.equal(buildWhatsAppCapiPayload({ ...base, hashedPhone: ["0501234567"] }).data[0].user_data.ph, undefined);
  assert.equal(buildWhatsAppCapiPayload(base).data[0].user_data.ph, undefined);
});

test("WhatsApp sender adds hashed phone only when WA_CAPI_SEND_HASHED_PHONE=true", async () => {
  const row = { id: "r1", lead_id: "l1", waba_id: "987654321", ctwa_clid: "AfcT3sTcLiCkId_abc-123XYZ", event_name: "Purchase",
    event_time: NOW / 1000 - 60, value: 100, currency: "AED", status: "pending", attempts: 0 };
  const mk = () => ({ from: (t) => { let patch = null; const q = { select: () => q, order: () => q, limit: () => q, lt: () => q, eq: () => q, in: () => q, gte: () => q,
    update: (p) => { patch = p; return q; },
    maybeSingle: async () => ({ data: t === "leads" ? { phone: "0501234567" } : { id: "r1" }, error: null }),
    then: (res, rej) => Promise.resolve(patch ? { error: null } : { data: [row], error: null }).then(res, rej) }; return q; } });
  const sent = [];
  await sendWhatsAppCapiEvents(mk(), { execute: true, clock: () => NOW, send: async (p) => sent.push(p), env: {} });
  await sendWhatsAppCapiEvents(mk(), { execute: true, clock: () => NOW, send: async (p) => sent.push(p), env: { WA_CAPI_SEND_HASHED_PHONE: "true" } });
  assert.equal(sent[0].data[0].user_data.ph, undefined);
  assert.deepEqual(sent[1].data[0].user_data.ph, [sha("971501234567")]);
});

import { planSheetQuote } from "../../src/lib/sheet-quote.mjs";
import { enqueueWebsiteQuoteForProgress } from "../../src/lib/website-capi-valued.mjs";
import { enqueueWhatsAppCapiForProgress } from "../../src/lib/whatsapp-capi.mjs";
import { latestQuotationAmount } from "../../src/lib/quote-amount.mjs";

test("sheet quote: forward only, never OS-final, fresh only, first-seen date as fallback", () => {
  const now = NOW; const iso = (ms) => new Date(ms).toISOString();
  const ok = planSheetQuote({ lead: { stage: "contacted" }, sheet: { amount: 120000 }, firstSeenIso: iso(now - 3600e3), nowMs: now });
  assert.deepEqual([ok.action, ok.advanceStage, ok.value, ok.currency], ["queue", true, 120000, "AED"]);
  assert.equal(planSheetQuote({ lead: { stage: "negotiation" }, sheet: { amount: 1 }, firstSeenIso: iso(now), nowMs: now }).advanceStage, false);
  assert.equal(planSheetQuote({ lead: { stage: "quotation_submitted" }, sheet: { amount: 1 }, firstSeenIso: iso(now), nowMs: now }).advanceStage, false);
  assert.equal(planSheetQuote({ lead: { stage: "new", final_status: "won" }, sheet: { amount: 1 }, firstSeenIso: iso(now), nowMs: now }).reason, "os_final");
  assert.equal(planSheetQuote({ lead: { stage: "lost" }, sheet: { amount: 1 }, firstSeenIso: iso(now), nowMs: now }).reason, "os_final");
  assert.equal(planSheetQuote({ lead: { stage: "new" }, sheet: { amount: 1, quotedAtIso: iso(now - 8 * 86400e3) }, nowMs: now }).reason, "stale");
  assert.equal(planSheetQuote({ lead: { stage: "new" }, sheet: { amount: 1, quotedAtIso: iso(now - 6 * 86400e3) }, nowMs: now }).action, "queue");
  assert.equal(planSheetQuote({ lead: { stage: "new" }, sheet: { amount: 0 }, firstSeenIso: iso(now), nowMs: now }).reason, "no_amount");
});

// db returning one quotation for the quote amount, plus lead / business_events for the website path.
function quoteDb({ lead = websiteLead, quotes = [{ total_amount: "150000.00", currency: "aed" }] } = {}) {
  const inserts = [];
  const from = (table) => {
    const q = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q, insert: (r) => { inserts.push(r); return q; },
      update: () => q,
      maybeSingle: async () => table === "leads" ? { data: lead, error: null } : { data: { id: "x" }, error: null },
      then: (res, rej) => Promise.resolve({ data: table === "quotations" ? quotes : null, error: null }).then(res, rej) };
    return q;
  };
  return { from, inserts };
}

test("latestQuotationAmount reads the quoted total, rejects zero", async () => {
  assert.deepEqual(await latestQuotationAmount(quoteDb(), "l"), { value: 150000, currency: "AED" });
  assert.equal(await latestQuotationAmount(quoteDb({ quotes: [{ total_amount: 0, currency: "AED" }] }), "l"), null);
  assert.equal(await latestQuotationAmount(quoteDb({ quotes: [] }), "l"), null);
});

test("website quote event: InitiateCheckout with the quoted amount, once per lead, only at the quotation step", async () => {
  const db = quoteDb(); const tried = [];
  assert.equal(await enqueueWebsiteQuoteForProgress(db, "l1", "quotation_submitted", { attempt: async (_d, row, kind) => tried.push([row, kind]), nowSeconds: NOW / 1000 }), "queued");
  const e = db.inserts[0];
  assert.equal(e.event_type, "meta_capi_quote_delivery");
  assert.equal(e.event_data.payload.data[0].event_name, "InitiateCheckout");
  assert.equal(e.event_data.payload.data[0].event_id, "quote:evt1");
  assert.deepEqual(e.event_data.payload.data[0].custom_data, { currency: "AED", value: 150000, lead_event_source: "website" });
  assert.equal(tried[0][1], "quote");
  assert.equal(await enqueueWebsiteQuoteForProgress(quoteDb(), "l1", "negotiation", {}), "skipped");
  assert.equal(await enqueueWebsiteQuoteForProgress(quoteDb({ quotes: [] }), "l1", "quotation", {}), "skipped");
});

test("WhatsApp quotation step queues QualifiedLead and a valued InitiateCheckout", async () => {
  const rows = [];
  const from = (table) => {
    const q = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
      upsert: (r) => { rows.push(r); return Promise.resolve({ error: null }); },
      maybeSingle: async () => table === "leads" ? { data: { ctwa_clid: "AfcT3sTcLiCkId_abc-123XYZ" }, error: null }
        : table === "whatsapp_conversations" ? { data: { waba_id: "987654321" }, error: null } : { data: null, error: null },
      then: (res, rej) => Promise.resolve({ data: table === "quotations" ? [{ total_amount: 90000, currency: "AED" }] : null, error: null }).then(res, rej) };
    return q;
  };
  await enqueueWhatsAppCapiForProgress({ from }, "l1", "quotation_submitted");
  assert.deepEqual(rows.map((r) => r.event_name), ["QualifiedLead", "InitiateCheckout"]);
  assert.equal(rows[1].value, 90000); assert.equal(rows[1].currency, "AED");
  const p = buildWhatsAppCapiPayload({ eventId: "e", wabaId: "123456", ctwaClid: "AfcT3sTcLiCkId_abc-123XYZ", eventName: "InitiateCheckout", eventTime: 5, value: 90000, currency: "AED" });
  assert.deepEqual(p.data[0].custom_data, { currency: "AED", value: 90000 });
});

test("CRM Quoted carries the quoted amount from the newest live quotation", async () => {
  const sent = [];
  const row = { ...crmRow, event_name: "Quoted" };
  const db = crmDb(row);
  const base = db.from;
  db.from = (t) => { const q = base(t); if (t === "quotations") { const th = q.then; q.not = () => q; q.then = (res, rej) => Promise.resolve({ data: [{ total_amount: 77000, currency: "AED" }], error: null }).then(res, rej); } return q; };
  await sendMetaCrmEvents(db, { execute: true, clock: () => NOW, send: async (p) => sent.push(p), env: {} });
  assert.equal(sent[0].data[0].event_name, "Quoted");
  assert.equal(sent[0].data[0].custom_data.value, 77000);
});
