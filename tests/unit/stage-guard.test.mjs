import test from 'node:test';
import assert from 'node:assert/strict';
const transitions = {
  new: ['contacted', 'won', 'lost'],
  contacted: ['requirement_confirmed', 'won', 'lost'],
  requirement_confirmed: ['solution_submitted', 'won', 'lost'],
  solution_submitted: ['quotation_submitted', 'won', 'lost'],
  quotation_submitted: ['negotiation', 'won', 'lost'],
  negotiation: ['pending_decision', 'won', 'lost'],
  pending_decision: ['won', 'lost'],
  won: [],
  lost: [],
};
function valid(from, to) { return from === to || (transitions[from] ?? []).includes(to); }
test('lead stage allows forward movement and terminal close', () => {
  assert.equal(valid('new', 'contacted'), true);
  assert.equal(valid('quotation_submitted', 'won'), true);
  assert.equal(valid('negotiation', 'lost'), true);
});
test('lead stage blocks skip/backward and terminal rollback', () => {
  assert.equal(valid('new', 'quotation_submitted'), false);
  assert.equal(valid('negotiation', 'contacted'), false);
  assert.equal(valid('won', 'contacted'), false);
  assert.equal(valid('lost', 'new'), false);
});
