import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildMetaCrmPayload, hashedContactKeys } from "../../src/lib/meta-crm-events.ts";
import { sendMetaCrmEvents } from "../../scripts/meta-crm-events-send.mjs";
import { buildWebsiteValuedPayload, enqueueWebsiteValuedEvent } from "../../src/lib/website-capi-valued.mjs";
import { buildWhatsAppCapiPayload } from "../../src/lib/whatsapp-capi.mjs";
import { sendWhatsAppCapiEvents } from "../../scripts/whatsapp-capi-send.mjs";
import { retryCapiDeliveries } from "../../scripts/meta-capi-retry.mjs";
import { decideChange, buildIndexes, moneyNumber, resolveConfig } from "../../src/lib/drive-sync.mjs";

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
  assert.equal(db.inserts[0].event_type, "meta_capi_lead_delivery");
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

import { planSheetQuote, shouldAdvanceStageForQuote } from "../../src/lib/sheet-quote.mjs";
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
  assert.equal(e.event_type, "meta_capi_lead_delivery");
  assert.equal(e.event_data.payload.data[0].event_name, "InitiateCheckout");
  assert.equal(e.event_data.payload.data[0].event_id, "quote:evt1");
  assert.deepEqual(e.event_data.payload.data[0].custom_data, { currency: "AED", value: 150000, lead_event_source: "website" });
  assert.equal(tried[0][1], "quote");
  assert.equal(await enqueueWebsiteQuoteForProgress(quoteDb(), "l1", "negotiation", {}), "skipped");
  assert.equal(await enqueueWebsiteQuoteForProgress(quoteDb({ quotes: [] }), "l1", "quotation", {}), "skipped");
});

test("WhatsApp quotation step queues QualifiedLead (table) and a valued InitiateCheckout (outbox, no schema change)", async () => {
  const rows = []; const outbox = []; const tried = [];
  const from = (table) => {
    const q = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
      upsert: (r) => { rows.push(r); return Promise.resolve({ error: null }); },
      insert: (r) => { outbox.push(r); return q; },
      maybeSingle: async () => table === "leads" ? { data: { ctwa_clid: "AfcT3sTcLiCkId_abc-123XYZ", phone: "0501234567" }, error: null }
        : table === "whatsapp_conversations" ? { data: { waba_id: "987654321" }, error: null } : { data: { id: "x" }, error: null },
      then: (res, rej) => Promise.resolve({ data: table === "quotations" ? [{ total_amount: 90000, currency: "AED" }] : null, error: null }).then(res, rej) };
    return q;
  };
  await enqueueWhatsAppCapiForProgress({ from }, "l1", "quotation_submitted", { attempt: async (_d, row) => tried.push(row), env: {} });
  assert.deepEqual(rows.map((r) => r.event_name), ["QualifiedLead"]);
  const e = outbox[0].event_data.payload.data[0];
  assert.equal(outbox[0].event_type, "meta_capi_lead_delivery");
  assert.equal([e.event_name, e.action_source, e.messaging_channel].join("|"), "InitiateCheckout|business_messaging|whatsapp");
  assert.deepEqual(e.custom_data, { currency: "AED", value: 90000 });
  assert.equal(e.user_data.ph, undefined); assert.equal(tried.length, 1);
  await enqueueWhatsAppCapiForProgress({ from }, "l1", "quotation_submitted", { env: { WA_CAPI_SEND_HASHED_PHONE: "true" } });
  assert.deepEqual(outbox[1].event_data.payload.data[0].user_data.ph, [sha("971501234567")]);
});

test("retry tool picks the delivery kind and sender from the stored payload", async () => {
  const mk = (id, payload) => ({ id, event_data: { status: "pending", attempts: 0, queued_at: new Date(NOW - 3600e3).toISOString(), event_id: payload.data[0].event_id, payload } });
  const wa = buildWhatsAppCapiPayload({ eventId: "wa-quote:l1", wabaId: "123456", ctwaClid: "AfcT3sTcLiCkId_abc-123XYZ", eventName: "InitiateCheckout", eventTime: NOW / 1000 - 3600, value: 5, currency: "AED" });
  const web = buildWebsiteValuedPayload({ kind: "quote", leadEventId: "evt1", storedUserData: stored, value: 5, currency: "AED", eventTime: NOW / 1000 - 3600 });
  const rows = [mk("a", wa), mk("b", web), { id: "c", event_data: { status: "pending", attempts: 0, queued_at: new Date(NOW).toISOString(), event_id: "z", payload: { data: [{ event_name: "Mystery" }] } } }];
  const updates = [];
  const db = { from: () => { let patch = null; const q = { select: () => q, eq: () => q, in: () => q, gte: () => q, order: () => q, limit: () => q,
    update: (p) => { patch = p; updates.push(p); return q; }, maybeSingle: async () => ({ data: { id: "x" }, error: null }),
    then: (res, rej) => Promise.resolve({ data: patch ? null : rows, error: null }).then(res, rej) }; return q; } };
  const sentMeta = []; const sentWa = [];
  const summary = await retryCapiDeliveries(db, { execute: true, now: NOW, send: async (p) => sentMeta.push(p), sendWhatsApp: async (p) => sentWa.push(p) });
  assert.equal(summary.examined, 2); assert.equal(summary.delivered, 2);
  assert.equal(sentWa[0].data[0].action_source, "business_messaging");
  assert.equal(sentMeta[0].data[0].action_source, "system_generated");
});

test("retry tool: stale Lead rows inside the 6-day fetch window do not starve newer rows", async () => {
  const leadRow = (id, ageMs) => ({ id, event_data: { status: "failed", attempts: 1, queued_at: new Date(NOW - ageMs).toISOString(), event_id: id,
    payload: { data: [{ event_name: "Lead", action_source: "website", event_id: id, event_time: Math.floor((NOW - ageMs) / 1000) }] } } });
  const web = buildWebsiteValuedPayload({ kind: "quote", leadEventId: "evt9", storedUserData: stored, value: 5, currency: "AED", eventTime: NOW / 1000 - 60 });
  const rows = [...Array.from({ length: 25 }, (_, i) => leadRow(`old${i}`, 2 * 86_400_000)),
    { id: "fresh", event_data: { status: "pending", attempts: 0, queued_at: new Date(NOW - 60e3).toISOString(), event_id: web.data[0].event_id, payload: web } }];
  let asked = 0;
  const db = { from: () => { const q = { select: () => q, eq: () => q, in: () => q, gte: () => q, order: () => q,
    limit: (n) => { asked = n; return q; }, then: (res, rej) => Promise.resolve({ data: rows.slice(0, asked), error: null }).then(res, rej) }; return q; } };
  const summary = await retryCapiDeliveries(db, { limit: 20, now: NOW });
  assert.equal(summary.examined, 1); // the fresh quote row is reached; the 25 stale Lead rows are skipped
});

test("drive sync: quote amount parsing is strict (no wrong value to Meta from a mis-typed cell)", () => {
  for (const [raw, want] of [["AED 120,000", 120000], ["120000", 120000], ["120,000.50 AED", 120000.5], ["Dhs 5 000", 5000], [95000, 95000],
    ["12k", null], ["1.2M", null], ["TBD", null], ["-5", null], ["0", null], ["100-200", null], ["", null]]) assert.equal(moneyNumber(raw), want, String(raw));
});

const DS = { opp_stage: "Quotation reported", quote_value: "AED 120,000" };
const dsChange = (o = {}) => ({ key: "META-123456789012345", sheet: "lead_register", row: 8, identity: { phone_digits: "971501234567" }, owned: {}, ...DS, ...o });
const dsLead = (o = {}) => ({ id: "L1", phone: "+971501234567", stage: "contacted", final_status: null, archived: false, quality: "normal", quotation_value: null, updated_at: "2026-11-01T00:00:00.000Z", drive_sync: null, ...o });
const dsDecide = (change, lead) => decideChange(change, buildIndexes([lead]), resolveConfig({}), new Map());

test("drive sync: a quote already in the sheet at the first sync is stored but never sent", () => {
  const d = dsDecide(dsChange(), dsLead());
  assert.equal(d.quote, undefined); assert.equal(d.set.quotation_value, 120000);
  assert.equal(d.raw_patch.drive_sync.quote_state, "baseline_skipped"); assert.equal(d.raw_patch.drive_sync.quote_baseline, true);
  const ins = decideChange(dsChange(), buildIndexes([]), resolveConfig({ DRIVE_SYNC_ALLOW_INSERT: "true" }), new Map());
  assert.equal(ins.action, "hold"); // insertable false by default: no insert without the flag/shape
});

test("drive sync: a quote that appears after the baseline fires once; the stage is moved by the database routine, never by a direct write", () => {
  const base = dsDecide(dsChange({ opp_stage: "", quote_value: "" }), dsLead());
  assert.equal(base.raw_patch.drive_sync.quote_baseline, true); assert.equal(base.set.stage, undefined);
  const prev = { ...base.raw_patch.drive_sync, row_hash: base.row_hash, synced_at: "2026-11-02T00:00:00.000Z" };
  const d = dsDecide(dsChange(), dsLead({ drive_sync: prev }));
  assert.equal(d.quote.value, 120000); assert.equal(d.quote.currency, "AED"); assert.equal(d.set.quotation_value, 120000);
  assert.ok(!("stage" in d.set) && !("final_status" in d.set));
  assert.equal(d.stage_advance, true); // asks the route to call sync_advance_lead_stage_from_sheet
  const again = dsDecide(dsChange({ quote_value: "130000" }), dsLead({ drive_sync: { ...d.raw_patch.drive_sync, row_hash: "old" }, quotation_value: 120000 }));
  assert.equal(again.quote, undefined); assert.equal(again.set.quotation_value, 130000);
});

test("drive sync: stage_advance is asked for only on a live lead before quotation_submitted that the sheet says was quoted", () => {
  const prev = { quote_baseline: true, row_hash: "old" };
  // history quote at the first sync: stored and not sent, but the stage still follows the sheet
  assert.equal(dsDecide(dsChange(), dsLead()).stage_advance, true);
  for (const stage of ["new", "contacted", "requirement_confirmed", "solution_submitted"]) assert.equal(dsDecide(dsChange(), dsLead({ stage, drive_sync: prev })).stage_advance, true, stage);
  // never backwards or sideways, never terminal, never archived, never without a reported quote
  for (const stage of ["quotation_submitted", "negotiation", "pending_decision", "won", "lost", "no_answered"]) assert.equal(dsDecide(dsChange(), dsLead({ stage, drive_sync: prev })).stage_advance, undefined, stage);
  assert.equal(dsDecide(dsChange(), dsLead({ final_status: "won", drive_sync: prev })).stage_advance, undefined);
  assert.equal(dsDecide(dsChange(), dsLead({ archived: true, drive_sync: prev })).stage_advance, undefined);
  assert.equal(dsDecide(dsChange({ opp_stage: "Negotiation" }), dsLead({ drive_sync: prev })).stage_advance, undefined);
  assert.equal(dsDecide(dsChange({ quote_value: "" }), dsLead({ drive_sync: prev })).stage_advance, undefined);
  assert.equal(shouldAdvanceStageForQuote({ stage: "contacted" }), true);
  assert.equal(shouldAdvanceStageForQuote({ stage: "contacted", archived: true }), false);
  assert.equal(shouldAdvanceStageForQuote({ stage: "contacted", final_status: "lost" }), false);
  assert.equal(shouldAdvanceStageForQuote(null), false);
});

test("drive-ingest route calls the service-role stage routine, never writes the stage itself, and never fails the sync on it", () => {
  const route = readFileSync(new URL("../../src/app/api/sync/drive-ingest/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(d\.stage_advance\) \{[\s\S]*?supabaseAdmin\.rpc\("sync_advance_lead_stage_from_sheet", \{ p_lead_id: d\.lead_id, p_target_stage: "quotation_submitted", p_run_id: runId \}\)/);
  assert.match(route, /stage_advance_unavailable/);
  // the block is before the row hash commit and does not throw
  const block = route.slice(route.indexOf("if (d.stage_advance)"), route.indexOf("// Fresh quote in the sheet"));
  assert.doesNotMatch(block, /throw/);
  assert.ok(route.indexOf("if (d.stage_advance)") < route.indexOf("// Last step: commit the row hash"));
  // no direct write of leads.stage anywhere in the route
  assert.doesNotMatch(route, /update\(\{[^}]*\bstage\b\s*:/);
});

test("drive sync: OS-final, archived and OS-edited values are left alone", () => {
  const prev = { quote_baseline: true, row_hash: "old" };
  for (const l of [dsLead({ final_status: "won", drive_sync: prev }), dsLead({ stage: "lost", drive_sync: prev }), dsLead({ archived: true, drive_sync: prev })]) {
    const d = dsDecide(dsChange(), l);
    assert.equal(d.quote, undefined); assert.equal(d.set?.quotation_value, undefined);
  }
  const edited = dsDecide(dsChange(), dsLead({ drive_sync: prev, quotation_value: 99000 }));
  assert.equal(edited.set.quotation_value, undefined);
  assert.equal(dsDecide(dsChange({ opp_stage: "Negotiation" }), dsLead({ drive_sync: prev })).quote, undefined);
  assert.equal(dsDecide(dsChange({ quote_value: "" }), dsLead({ drive_sync: prev })).quote, undefined);
});

test("quote amount falls back to the sheet-reported quotation_value", async () => {
  const db = { from: (t) => { const q = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: { quotation_value: "88000.00" }, error: null }),
    then: (res, rej) => Promise.resolve({ data: t === "quotations" ? [] : null, error: null }).then(res, rej) }; return q; } };
  assert.deepEqual(await latestQuotationAmount(db, "l"), { value: 88000, currency: "AED" });
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

import { serializeMetaCrmPayload } from "../../src/lib/meta-crm-events.ts";
import { buildTestRequest } from "../../scripts/meta-capi-hash-test.mjs";

test("hashed keys: email-only, trimmed/lowercased, +971 0 prefix, 00971 prefix, only SHA-256 hex, nothing else", () => {
  assert.deepEqual(hashedContactKeys({ email: "  Sam@NewMe.AE " }), { em: [sha("sam@newme.ae")] });
  assert.deepEqual(hashedContactKeys({ phone: "+971 (0)50 123 4567" }), { ph: [sha("971501234567")] });
  assert.deepEqual(hashedContactKeys({ phone: "00971501234567" }), { ph: [sha("971501234567")] });
  const all = hashedContactKeys({ phone: "0501234567", email: "a@b.co", name: "x", id: "y" });
  assert.deepEqual(Object.keys(all).sort(), ["em", "ph"]);
  for (const h of [...all.ph, ...all.em]) assert.match(h, /^[0-9a-f]{64}$/);
});

test("CRM payload with hashed keys keeps exact lead_id and event shape", () => {
  const match = hashedContactKeys({ phone: "0501234567", email: "a@b.co" });
  const p = buildMetaCrmPayload({ leadgenId: "123456789012345678", eventName: "Quoted", eventTime: 5, eventId: "x", value: 10, currency: "AED", match });
  const e = p.data[0];
  assert.equal(e.action_source, "system_generated"); assert.equal(e.custom_data.lead_event_source, "crm");
  assert.deepEqual(Object.keys(e.user_data).sort(), ["em", "lead_id", "ph"]);
  assert.match(serializeMetaCrmPayload(p), /"lead_id":123456789012345678/);
});

test("WhatsApp payload keeps ctwa_clid and waba id next to the hashed phone, no other identifiers", () => {
  const e = buildWhatsAppCapiPayload({ eventId: "e", wabaId: "123456", ctwaClid: "AfcT3sTcLiCkId_abc-123XYZ", eventName: "InitiateCheckout", eventTime: 5,
    value: 1, currency: "AED", hashedPhone: [sha("971501234567")] }).data[0];
  assert.deepEqual(Object.keys(e.user_data).sort(), ["ctwa_clid", "ph", "whatsapp_business_account_id"]);
  assert.equal(e.action_source, "business_messaging");
});

test("hash test tool: test_event_code is top level, requires a valid code, never needs the database", () => {
  const env = { META_TEST_EVENT_CODE: "TEST123", META_PIXEL_ID: "1", META_WA_DATASET_ID: "2", TEST_LEAD_ID: "123456789012345678",
    TEST_PHONE: "0501234567", TEST_EMAIL: "a@b.co", TEST_WABA_ID: "123456", TEST_CTWA_CLID: "AfcT3sTcLiCkId_abc-123XYZ" };
  const crm = JSON.parse(buildTestRequest("crm", env, 5).body.replace(/"lead_id":(\d+)/, '"lead_id":"$1"'));
  assert.equal(crm.test_event_code, "TEST123"); assert.equal(crm.data[0].user_data.ph[0], sha("971501234567"));
  const wa = JSON.parse(buildTestRequest("wa", env, 5).body);
  assert.equal(wa.test_event_code, "TEST123"); assert.equal(wa.data[0].user_data.ph[0], sha("971501234567"));
  assert.throws(() => buildTestRequest("crm", { ...env, META_TEST_EVENT_CODE: "" }, 5));
});
