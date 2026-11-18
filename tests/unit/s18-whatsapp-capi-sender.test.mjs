import assert from "node:assert/strict";
import test from "node:test";
import { sendWhatsAppCapiEvents } from "../../scripts/whatsapp-capi-send.mjs";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const CLID = "AfcT3sTcLiCkId_abc-123XYZ";
const row = (over = {}) => ({ id: "r1", lead_id: "l1", waba_id: "987654321", ctwa_clid: CLID, event_name: "QualifiedLead",
  event_time: NOW / 1000 - 3600, value: null, currency: null, status: "pending", attempts: 0, lease_id: null, lease_until: null, ...over });

// Query builder that records the updates the sender makes; every compare-and-set succeeds unless told otherwise.
function fakeDb(rows, { claimFails = false, exhausted = [] } = {}) {
  const updates = [];
  const from = () => {
    let mode = "select"; let patch = null; let selectedStatuses = null; let gte = false;
    const q = {
      select: () => q, order: () => q, limit: () => q, lt: () => q, eq: () => q,
      in: (_c, statuses) => { selectedStatuses = statuses; return q; },
      gte: () => { gte = true; return q; },
      update: (p) => { mode = "update"; patch = p; updates.push(p); return q; },
      maybeSingle: async () => ({ data: claimFails && patch?.status === "sending" ? null : { id: "r1" }, error: null }),
      then: (resolve, reject) => Promise.resolve(mode === "update" ? { error: null } : { data: gte ? exhausted : rows, error: null }).then(resolve, reject),
    };
    return q;
  };
  return { from, updates };
}

test("dry run reads the queue and sends nothing", async () => {
  const sent = [];
  const db = fakeDb([row()]);
  const summary = await sendWhatsAppCapiEvents(db, { send: async (p) => sent.push(p), clock: () => NOW });
  assert.equal(summary.mode, "dry_run"); assert.equal(summary.examined, 1); assert.equal(sent.length, 0); assert.equal(db.updates.length, 0);
});

test("execute claims, sends the business-messaging payload and records delivery", async () => {
  const sent = [];
  const db = fakeDb([row()]);
  const summary = await sendWhatsAppCapiEvents(db, { execute: true, send: async (p) => sent.push(p), clock: () => NOW });
  assert.equal(summary.delivered, 1);
  assert.equal(sent[0].data[0].action_source, "business_messaging");
  assert.equal(sent[0].data[0].event_id, "r1");
  assert.deepEqual(db.updates.map((u) => u.status), ["sending", "delivered"]);
});

test("a failed send is recorded as failed for a later retry", async () => {
  const db = fakeDb([row()]);
  const summary = await sendWhatsAppCapiEvents(db, { execute: true, send: async () => { throw new Error("net"); }, clock: () => NOW });
  assert.equal(summary.failed, 1); assert.equal(db.updates.at(-1).status, "failed");
});

test("events older than seven days and invalid rows go to review and are never sent", async () => {
  const sent = [];
  const db = fakeDb([row({ event_time: NOW / 1000 - 8 * 86400 }), row({ id: "r2", event_name: "Purchase" })]);
  const summary = await sendWhatsAppCapiEvents(db, { execute: true, send: async (p) => sent.push(p), clock: () => NOW });
  assert.equal(summary.review_required, 2); assert.equal(sent.length, 0);
});

test("a lost claim race and a held lease are not sent twice", async () => {
  const sent = [];
  const lost = await sendWhatsAppCapiEvents(fakeDb([row()], { claimFails: true }), { execute: true, send: async (p) => sent.push(p), clock: () => NOW });
  assert.equal(lost.busy, 1);
  const held = await sendWhatsAppCapiEvents(fakeDb([row({ status: "sending", lease_until: new Date(NOW + 30_000).toISOString() })]), { execute: true, send: async (p) => sent.push(p), clock: () => NOW });
  assert.equal(held.busy, 1); assert.equal(sent.length, 0);
});

test("events that used every attempt are reported so the operator can alert on them", async () => {
  const summary = await sendWhatsAppCapiEvents(fakeDb([], { exhausted: [{ id: "x" }, { id: "y" }] }), { clock: () => NOW });
  assert.equal(summary.exhausted, 2);
});
