import assert from "node:assert/strict";
import test from "node:test";
import { attemptCapiDelivery } from "../../src/lib/meta-capi-delivery.ts";
import { websiteEventUuid, websiteLeadFingerprint } from "../../src/lib/website-lead-identity.ts";
import { retryCapiDeliveries } from "../../scripts/meta-capi-retry.mjs";

function queue(now = Date.now()) {
  return { id: "delivery-1", event_type: "meta_capi_lead_delivery", created_at: new Date(now).toISOString(),
    event_data: { status: "pending", attempts: 0, queued_at: new Date(now).toISOString(), event_id: "event-1",
      payload: { data: [{ event_id: "event-1", event_name: "Lead", event_time: Math.floor(now / 1000),
        action_source: "website", event_source_url: "https://newme.ae/budget-estimator/" }] } } };
}

// Models the single conditional UPDATE, not a lock in application memory.
function storage(initial) {
  const rows = structuredClone(initial);
  let writes = 0;
  const db = { from(table) {
    assert.equal(table, "business_events");
    let mutation, filters = [], maximum = Infinity;
    const valueOf = (row, key) => key.includes("->>") ? row.event_data[key.split("->>")[1]] : row[key];
    const run = (single) => {
      const matches = rows.filter((row) => filters.every((fn) => fn(row))).slice(0, maximum);
      if (mutation) for (const row of matches) { writes++; Object.assign(row, structuredClone(mutation)); }
      return { data: structuredClone(single ? matches[0] || null : matches), error: null };
    };
    const query = {
      select() { return this; }, update(value) { mutation = value; return this; },
      eq(key, value) { filters.push((row) => String(valueOf(row, key)) === String(value)); return this; },
      in(key, values) { filters.push((row) => values.includes(valueOf(row, key))); return this; },
      gte(key, value) { filters.push((row) => valueOf(row, key) >= value); return this; },
      order() { return this; }, limit(value) { maximum = value; return this; },
      async maybeSingle() { return run(true); },
      then(resolve, reject) { return Promise.resolve(run(false)).then(resolve, reject); },
    };
    return query;
  } };
  return { db, rows, writes: () => writes };
}

test("website UUIDs are stable, valid and separated by entity type", () => {
  const ids = ["lead", "task", "delivery"].map((kind) => websiteEventUuid(kind, "event"));
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(ids[0], websiteEventUuid("lead", "event"));
  assert.notEqual(ids[0], websiteEventUuid("lead", "another-event"));
  const inquiry = { customerName: "Synthetic", attribution: { eventId: "event" }, turnstileToken: "first" };
  assert.equal(websiteLeadFingerprint(inquiry), websiteLeadFingerprint({ ...inquiry, turnstileToken: "second" }));
  assert.notEqual(websiteLeadFingerprint(inquiry), websiteLeadFingerprint({ ...inquiry, customerName: "Changed" }));
});

test("stale concurrent snapshots acquire only one delivery lease", async () => {
  const initial = queue(), state = storage([initial]);
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let sends = 0;
  const first = attemptCapiDelivery(state.db, initial, async () => { sends++; entered(); await waiting; });
  await started;
  try {
    assert.equal(await attemptCapiDelivery(state.db, structuredClone(initial), async () => { sends++; }), "busy");
  } finally { release(); }
  assert.equal(await first, "delivered");
  assert.equal(sends, 1);
  assert.equal(state.rows[0].event_data.attempts, 1);
});

test("an expired lease is recoverable and its late former owner cannot overwrite the receipt", async () => {
  const now = Date.now(), initial = queue(now), state = storage([initial]);
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const first = attemptCapiDelivery(state.db, initial, async () => { entered(); await waiting; }, now);
  await started;
  assert.equal(await attemptCapiDelivery(state.db, structuredClone(state.rows[0]), async (payload) => {
    assert.deepEqual(payload, initial.event_data.payload);
  }, now + 61_000), "delivered");
  const receipt = structuredClone(state.rows[0]);
  release();
  await assert.rejects(first, /receipt unavailable/);
  assert.deepEqual(state.rows[0], receipt);
  assert.equal(receipt.event_data.attempts, 2);
});

test("old, exhausted, future and mismatched deliveries cannot be sent", async () => {
  const now = Date.now();
  const cases = [queue(now - 86_400_000), queue(now + 1), queue(now), queue(now), queue(now), queue(now), queue(now)];
  cases[2].event_data.attempts = 5;
  cases[3].event_data.payload.data[0].event_id = "different";
  cases[4].event_data = { ...cases[4].event_data, status: "sending", lease_until: "invalid" };
  cases[5].event_data.payload.data[0].event_time = Math.floor(now / 1000) - 86_400;
  cases[6].event_data.payload.data[0].event_source_url = "https://foreign.example/";
  for (const row of cases) {
    const state = storage([row]);
    assert.equal(await attemptCapiDelivery(state.db, row, async () => assert.fail("must not send"), now), "review_required");
    assert.equal(state.writes(), 0);
  }
});

test("a failed sender remains retryable and a completed delivery performs no writes", async () => {
  const initial = queue(), state = storage([initial]);
  assert.equal(await attemptCapiDelivery(state.db, initial, async () => { throw new Error("private upstream detail"); }), "failed");
  const failed = structuredClone(state.rows[0]);
  assert.equal(failed.event_data.status, "failed");
  assert.deepEqual(failed.event_data.payload, initial.event_data.payload);
  assert.doesNotMatch(JSON.stringify(failed), /private upstream detail/);
  assert.equal(await attemptCapiDelivery(state.db, failed, async () => {}), "delivered");
  const before = state.writes();
  assert.equal(await attemptCapiDelivery(state.db, structuredClone(state.rows[0]), async () => assert.fail("already delivered")), "delivered");
  assert.equal(state.writes(), before);
});

test("the prepared retry tool defaults to reads, uses the shared claim and bounds its batch", async () => {
  const state = storage([queue()]);
  let sends = 0;
  const dry = await retryCapiDeliveries(state.db, { send: async () => { sends++; } });
  assert.equal(dry.mode, "dry_run");
  assert.equal(dry.examined, 1);
  assert.equal(state.writes(), 0);
  assert.equal(sends, 0);
  const run = await retryCapiDeliveries(state.db, { execute: true, send: async () => { sends++; } });
  assert.equal(run.delivered, 1);
  assert.equal(sends, 1);
  await assert.rejects(retryCapiDeliveries(state.db, { limit: 101 }), /Invalid retry limit/);
});
