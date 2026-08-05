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

test("new lead cannot advance until quality is assessed", () => {
  const result = gate({ contactCount: 1 });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /quality/i);
});

test("one complete contact and an assessed quality unlock the stage", () => {
  for (const quality of ["good", "normal", "poor"]) {
    assert.deepEqual(gate({ contactCount: 1, quality }), { allowed: true, reasons: [] });
  }
});

test("three contacts do not bypass the quality requirement", () => {
  assert.equal(gate({ contactCount: 3, quality: null }).allowed, false);
});

test("direct new-to-won and new-to-lost transitions are gated", () => {
  assert.equal(gate({ nextStage: "won", contactCount: 0, quality: "good" }).allowed, false);
  assert.equal(gate({ nextStage: "lost", contactCount: 1, quality: null }).allowed, false);
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
