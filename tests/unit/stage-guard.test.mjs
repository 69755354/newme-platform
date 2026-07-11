import test from "node:test";
import assert from "node:assert/strict";
import {
  getValidStageTransitions,
  isValidStageTransition,
} from "../../src/shared/kanban/stage-transitions.mjs";

test("production stage guard allows forward movement and terminal close", () => {
  assert.equal(isValidStageTransition("new", "contacted"), true);
  assert.equal(isValidStageTransition("quotation_submitted", "won"), true);
  assert.equal(isValidStageTransition("negotiation", "lost"), true);
  assert.deepEqual(getValidStageTransitions("pending_decision"), ["won", "lost"]);
});

test("production stage guard blocks skip, backward, unknown, and terminal rollback", () => {
  assert.equal(isValidStageTransition("new", "quotation_submitted"), false);
  assert.equal(isValidStageTransition("negotiation", "contacted"), false);
  assert.equal(isValidStageTransition("won", "contacted"), false);
  assert.equal(isValidStageTransition("lost", "new"), false);
  assert.equal(isValidStageTransition("unknown", "won"), false);
  assert.deepEqual(getValidStageTransitions("won"), []);
});
