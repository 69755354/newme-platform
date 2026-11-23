import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFirstContactGate,
  isCompleteContact,
} from "../../src/lib/first-contact-gate.mjs";

const gate = (overrides = {}) => evaluateFirstContactGate({
  currentStage: "new",
  nextStage: "contacted",
  contactCount: 0,
  quality: null,
  ...overrides,
});

test("new lead cannot advance without a complete contact", () => {
  const result = gate({ quality: "good" });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /complete contact/i);
});

test("S39: the quality rating is optional, one complete contact is enough", () => {
  assert.deepEqual(gate({ contactCount: 1 }), { allowed: true, reasons: [] });
});

test("one complete contact unlocks the stage whatever the quality", () => {
  for (const quality of ["good", "normal", "poor", null, "pending"]) {
    assert.deepEqual(gate({ contactCount: 1, quality }), { allowed: true, reasons: [] });
  }
});

test("no contact record still blocks, with or without quality", () => {
  assert.equal(gate({ contactCount: 0, quality: "good" }).allowed, false);
  assert.equal(gate({ contactCount: 0, quality: null }).allowed, false);
});

test("direct new-to-won and new-to-lost transitions are gated", () => {
  assert.equal(gate({ nextStage: "won", contactCount: 0, quality: "good" }).allowed, false);
  assert.equal(gate({ nextStage: "lost", contactCount: 0, quality: "good" }).allowed, false);
});

test("transitions after First Contact are not re-gated", () => {
  assert.deepEqual(gate({ currentStage: "contacted", nextStage: "qualified" }), {
    allowed: true,
    reasons: [],
  });
});

test("only timestamped non-whitespace results are complete contacts", () => {
  assert.equal(isCompleteContact({
    contact_time: null,
    contact_result: "Interested",
  }), false);
  assert.equal(isCompleteContact({
    contact_time: "2026-07-12T09:00:00.000Z",
    contact_result: "   ",
  }), false);
  assert.equal(isCompleteContact({
    contact_time: "2026-07-12T09:00:00.000Z",
    contact_result: "Interested",
  }), true);
});
