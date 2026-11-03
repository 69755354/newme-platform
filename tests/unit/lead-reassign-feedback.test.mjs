// S3 #3 — a second reassignment from the same page without a refresh.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { applyReassignResult, reassignFailureKey, reassignNeedsReload } from "../../src/lib/lead-reassign-feedback.mjs";

// The database half: reassign_lead_atomic() refuses a token that is not the
// row's current updated_at and stamps a new one on success.
function casDatabase(initial) {
  const row = { ...initial };
  let tick = 0;
  return {
    reassign(to, expected) {
      if (expected !== row.updated_at) return { status: 409, body: { code: "CONCURRENT_LEAD_UPDATE" } };
      row.assigned_to = to;
      row.updated_at = `2026-11-04T10:00:0${++tick}.000000+00:00`;
      return { status: 200, body: { success: true, result: { assigned_to: to, updated_at: row.updated_at } } };
    },
  };
}

test("two reassignments in a row succeed when the page keeps the returned token", () => {
  const db = casDatabase({ assigned_to: "A", updated_at: "2026-11-04T09:00:00.000000+00:00" });
  let lead = { id: "L", assigned_to: "A", updated_at: "2026-11-04T09:00:00.000000+00:00" };
  for (const to of ["B", "A"]) {
    const response = db.reassign(to, lead.updated_at);
    assert.equal(response.status, 200, `reassign to ${to}`);
    lead = applyReassignResult(lead, { assignedTo: to, repName: to, result: response.body.result });
  }
  assert.equal(lead.assigned_to, "A");
});

test("keeping the old token (the previous behaviour) makes the second attempt conflict", () => {
  const db = casDatabase({ assigned_to: "A", updated_at: "t0" });
  const lead = { assigned_to: "A", updated_at: "t0" };
  assert.equal(db.reassign("B", lead.updated_at).status, 200);
  assert.equal(db.reassign("A", lead.updated_at).status, 409);
});

test("failures map to localised keys, conflicts ask for a reload", () => {
  assert.equal(reassignFailureKey(409, "CONCURRENT_LEAD_UPDATE"), "leadFlow.reassign.conflict");
  assert.equal(reassignNeedsReload(409, "CONCURRENT_LEAD_UPDATE"), true);
  assert.equal(reassignFailureKey(403, "FORBIDDEN_REASSIGNMENT"), "leadFlow.reassign.forbidden");
  assert.equal(reassignFailureKey(400, "INVALID_ASSIGNEE"), "leadFlow.reassign.invalidAssignee");
  assert.equal(reassignFailureKey(500, undefined), "leadFlow.reassign.failed");
  assert.equal(reassignNeedsReload(400, "INVALID_ASSIGNEE"), false);
});

test("both reassignment hooks keep the token and never toast the raw database code", () => {
  const detail = fs.readFileSync("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts", "utf8");
  assert.match(detail, /applyReassignResult\([^)]*\{\s*assignedTo: newUserId,[\s\S]*?result: payload\.result/);
  assert.doesNotMatch(detail, /toast\.error\(payload\.error \|\| t\("common\.saveFailed"\)\);\s*return;\s*}\s*setLead\(\{ \.\.\.oldLead/);
  const list = fs.readFileSync("src/app/(dashboard)/leads/_hooks/useLeadMutations.ts", "utf8");
  assert.match(list, /reassignFailureKey\(response\.status, code\)/);
  assert.doesNotMatch(list, /setError\(payload\.error \|\| t\("common\.saveFailed"\)\)/);
});
