// S3 #6 — removing a salesperson used to hand all their leads to the active
// colleague with the lowest UUID via one direct update (no transfer history).
// Now the administrator must choose a receiver or the unassigned queue, and
// every lead goes through the audited routine with a per-lead idempotency key.
import assert from "node:assert/strict";
import test from "node:test";
import { handOverMemberLeads, readHandoverTarget, UNASSIGNED_QUEUE } from "../../src/lib/member-lead-handover.mjs";
import { deriveLeadTransferKey } from "../../src/lib/lead-transfer-batch.mjs";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const LEADS = [
  { id: "44444444-4444-4444-8444-444444444441", updated_at: "2026-11-01T00:00:00Z" },
  { id: "44444444-4444-4444-8444-444444444442", updated_at: "2026-11-02T00:00:00Z" },
];

function client(rpcErrors = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, "leads");
      return {
        select() { return this; },
        async eq(column, value) {
          assert.deepEqual([column, value], ["assigned_to", MEMBER]);
          return { data: LEADS, error: null };
        },
      };
    },
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: {}, error: rpcErrors[args.p_lead_id] ?? null };
    },
  };
}

test("there is no default receiver: the choice is required and cannot be the member", () => {
  assert.deepEqual(readHandoverTarget(undefined, MEMBER), { ok: false, code: "HANDOVER_TARGET_REQUIRED" });
  assert.deepEqual(readHandoverTarget("", MEMBER), { ok: false, code: "HANDOVER_TARGET_REQUIRED" });
  assert.deepEqual(readHandoverTarget(MEMBER, MEMBER), { ok: false, code: "HANDOVER_TARGET_IS_MEMBER" });
  assert.deepEqual(readHandoverTarget(TARGET, MEMBER), { ok: true, target: TARGET });
  assert.deepEqual(readHandoverTarget(UNASSIGNED_QUEUE, MEMBER), { ok: true, target: null });
});

test("a chosen receiver gets every lead through reassign_lead_atomic with CAS and per-lead keys", async () => {
  const db = client();
  const report = await handOverMemberLeads(db, { memberId: MEMBER, target: TARGET, batchKey: BATCH });
  assert.equal(report.complete, true);
  assert.deepEqual(report.moved, LEADS.map((l) => l.id));
  assert.deepEqual(db.calls, LEADS.map((lead) => ["reassign_lead_atomic", {
    p_lead_id: lead.id,
    p_expected_updated_at: lead.updated_at,
    p_idempotency_key: deriveLeadTransferKey(BATCH, lead.id),
    p_reason: "member_removed",
    p_new_assignee: TARGET,
  }]));
});

test("the unassigned queue uses unassign_lead_atomic (audited, no receiver)", async () => {
  const db = client();
  const report = await handOverMemberLeads(db, { memberId: MEMBER, target: null, batchKey: BATCH });
  assert.equal(report.complete, true);
  assert.deepEqual(db.calls.map(([name]) => name), ["unassign_lead_atomic", "unassign_lead_atomic"]);
  assert.equal("p_new_assignee" in db.calls[0][1], false);
});

test("a conflict or failure makes the hand-over incomplete (caller must not deactivate)", async () => {
  const db = client({
    [LEADS[0].id]: { message: "CONCURRENT_LEAD_UPDATE" },
    [LEADS[1].id]: { message: "boom" },
  });
  const report = await handOverMemberLeads(db, { memberId: MEMBER, target: TARGET, batchKey: BATCH });
  assert.equal(report.complete, false);
  assert.deepEqual(report.conflicts, [LEADS[0].id]);
  assert.equal(report.failed.length, 1);
  await assert.rejects(handOverMemberLeads(db, { memberId: MEMBER, target: TARGET, batchKey: "nope" }));
});
