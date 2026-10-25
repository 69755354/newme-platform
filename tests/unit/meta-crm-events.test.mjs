import assert from "node:assert/strict";
import test from "node:test";
import {
  META_CRM_STAGE_EVENTS, buildMetaCrmPayload, enqueueMetaCrmStageEvent, normalizeLeadgenId, serializeMetaCrmPayload,
} from "../../src/lib/meta-crm-events.ts";
import { sendMetaCrmEvents } from "../../scripts/meta-crm-events-send.mjs";

test("normalizeLeadgenId accepts Meta ids and rejects junk", () => {
  assert.equal(normalizeLeadgenId("l:123456789012345"), "123456789012345");
  assert.equal(normalizeLeadgenId(123456789012345), "123456789012345");
  for (const bad of ["", "abc", "12", null, undefined, {}, "1; drop table"]) assert.equal(normalizeLeadgenId(bad), null);
});

test("payload preserves CRM source fields and exact lead id digits", () => {
  const p = buildMetaCrmPayload({ leadgenId: "123456789012345", eventName: "Qualified", eventTime: 1_800_000_000 });
  assert.deepEqual(p.data[0], {
    event_name: "Qualified", event_time: 1_800_000_000, action_source: "system_generated",
    user_data: { lead_id: "123456789012345" }, custom_data: { lead_event_source: "crm", event_source: "crm" },
  });
  assert.throws(() => buildMetaCrmPayload({ leadgenId: "x", eventName: "Lead", eventTime: 1 }));
  assert.equal(buildMetaCrmPayload({ leadgenId: "9".repeat(20), eventName: "Lead", eventTime: 1 }).data[0].user_data.lead_id, "9".repeat(20));
});

test("every lead-detail milestone has an event name; Qualified is requirements", () => {
  for (const m of ["first_contact", "basic_info", "drawings", "requirements", "solution", "quotation", "meeting"]) {
    assert.ok(META_CRM_STAGE_EVENTS[m], m);
  }
  assert.equal(META_CRM_STAGE_EVENTS.requirements, "Qualified");
  assert.equal(META_CRM_STAGE_EVENTS.first_contact, META_CRM_STAGE_EVENTS.contacted);
});

test("every pipeline stage has an event name; Qualified is requirement_confirmed", () => {
  for (const s of ["new", "contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted",
    "negotiation", "pending_decision", "won", "lost"]) assert.ok(META_CRM_STAGE_EVENTS[s], s);
  assert.equal(META_CRM_STAGE_EVENTS.requirement_confirmed, "Qualified");
});

function fakeDb() {
  const rows = [];
  return { rows, from() { return { upsert(row, opts) {
    assert.equal(opts.onConflict, "lead_id,crm_stage"); assert.equal(opts.ignoreDuplicates, true);
    rows.push(row); return Promise.resolve({ error: null });
  } }; } };
}

test("enqueue skips leads without a Meta id or unknown stages and never throws", async () => {
  const db = fakeDb();
  assert.equal(await enqueueMetaCrmStageEvent(db, { id: "a", meta_leadgen_id: null }, "contacted"), "skipped");
  assert.equal(await enqueueMetaCrmStageEvent(db, { id: "a", meta_leadgen_id: "123456789012345" }, "weird"), "skipped");
  assert.equal(await enqueueMetaCrmStageEvent(db, { id: "a", meta_leadgen_id: "123456789012345" }, "contacted", 1_800_000_000), "queued");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].event_name, "Contacted");
  // The outbox key is the funnel event, so the milestone path reporting the
  // same step collapses onto the same (lead, crm_stage) row.
  assert.equal(db.rows[0].crm_stage, "Contacted");
  assert.equal(await enqueueMetaCrmStageEvent(db, { id: "a", meta_leadgen_id: "123456789012345" }, "first_contact", 1_800_000_000), "queued");
  assert.equal(db.rows[1].crm_stage, "Contacted");
  assert.equal(await enqueueMetaCrmStageEvent({ from() { throw new Error("boom"); } }, { id: "a", meta_leadgen_id: "123456789012345" }, "won"), "skipped");
});

function queueDb({ row }) {
  const updates = [];
  const queue = { select() { return queue; }, in() { return queue; }, lt() { return queue; }, order() { return queue; },
    limit() { return Promise.resolve({ data: [row], error: null }); } };
  const upd = (patch) => {
    updates.push(patch);
    const u = { eq() { return u; }, select() { return u; },
      maybeSingle() { return Promise.resolve({ data: { id: row.id }, error: null }); },
      then(res) { return Promise.resolve({ error: null }).then(res); } };
    return u;
  };
  return { state: { updates }, from() { return { select: () => queue, update: upd }; } };
}

test("send tool: dry run sends nothing; execute sends once and records delivery", async () => {
  const now = 1_800_000_100_000;
  const row = { id: "r1", meta_leadgen_id: "123456789012345", event_name: "Qualified",
    event_time: 1_800_000_000, status: "pending", attempts: 0 };
  let sent = 0;
  const send = async (payload) => { sent++; assert.equal(payload.data[0].action_source, "system_generated"); };
  const dry = await sendMetaCrmEvents(queueDb({ row }), { clock: () => now, send });
  assert.equal(dry.mode, "dry_run"); assert.equal(sent, 0);
  const db = queueDb({ row });
  const done = await sendMetaCrmEvents(db, { execute: true, clock: () => now, send });
  assert.equal(done.delivered, 1); assert.equal(sent, 1);
  assert.ok(db.state.updates.some((u) => u.status === "delivered"));
});

test("send tool: stale events go to review and are never sent", async () => {
  const now = 1_800_000_000_000 + 8 * 86_400_000;
  const row = { id: "r2", meta_leadgen_id: "123456789012345", event_name: "Lead",
    event_time: 1_800_000_000, status: "pending", attempts: 0 };
  let sent = 0;
  const db = queueDb({ row });
  const out = await sendMetaCrmEvents(db, { execute: true, clock: () => now, send: async () => { sent++; } });
  assert.equal(out.review_required, 1); assert.equal(sent, 0);
});

test("send tool: each claim leases from the claim moment, not the batch start", async () => {
  const start = 1_800_000_000_000;
  let calls = 0;
  const clock = () => (calls++ === 0 ? start : start + 10 * 60_000); // batch runs ten minutes
  const row = { id: "r3", meta_leadgen_id: "123456789012345", event_name: "Lead",
    event_time: Math.floor(start / 1000) - 60, status: "pending", attempts: 0 };
  const db = queueDb({ row });
  await sendMetaCrmEvents(db, { execute: true, clock, send: async () => {} });
  const claim = db.state.updates.find((u) => u.status === "sending");
  assert.ok(Date.parse(claim.lease_until) >= start + 10 * 60_000 + 60_000, "lease must start at the claim");
});

test("send tool: an event newer than the sender's clock is deferred, never retired", async () => {
  const now = 1_800_000_000_000;
  const row = { id: "r4", meta_leadgen_id: "123456789012345", event_name: "Qualified",
    event_time: Math.floor(now / 1000) + 2, status: "pending", attempts: 0 };
  let sent = 0;
  const db = queueDb({ row });
  const out = await sendMetaCrmEvents(db, { execute: true, clock: () => now, send: async () => { sent++; } });
  assert.equal(out.busy, 1); assert.equal(out.review_required, 0); assert.equal(sent, 0);
  assert.deepEqual(db.state.updates, []);
});

test("17 digit Meta lead ids remain exact in the prepared payload", () => {
  const leadgenId="12345678901234567";
  const payload=buildMetaCrmPayload({leadgenId,eventName:"Qualified",eventTime:1800000000});
  assert.equal(String(payload.data[0].user_data.lead_id),leadgenId);
});

test("numeric JSON preserves all 17 digits and rejects rounded numeric inputs", () => {
  const leadgenId="12345678901234567";
  const payload=buildMetaCrmPayload({leadgenId,eventName:"Qualified",eventTime:1800000000});
  const wire=serializeMetaCrmPayload(payload);
  assert.match(wire, /"lead_id":12345678901234567(?=[,}])/);
  assert.doesNotMatch(wire, /"lead_id":"|12345678901234568/);
  assert.equal(normalizeLeadgenId(Number(leadgenId)),null);
  assert.equal(normalizeLeadgenId("000123456789012345"),null);
  assert.throws(()=>serializeMetaCrmPayload({data:[{...payload.data[0],user_data:{lead_id:'12345678901234567, "injected":true'}}]}));
});
