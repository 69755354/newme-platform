import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const cases = [
  ['src/app/api/leads/[id]/quality/route.ts', ['getRequestAuthContext', 'assigned_to', '403']],
  ['src/app/api/contracts/[id]/route.ts', ['auth.getUser', 'sales_id', '403']],
  ['src/app/api/payments/[id]/confirm/route.ts', ['auth.getUser', 'admin', 'finance']],
  ['src/app/api/tasks/[id]/route.ts', ['getRequestAuthContext', 'assignee_id', '404']],
  // R1 · the two server-action modules resolve their caller through
  // getActionAuthContext() rather than calling auth.getUser() themselves, so the
  // needle is the boundary's name. It is the stronger claim: auth.getUser() only
  // says a session was read, while the choke point also refuses a deactivated or
  // forced one. tests/security/forced-password-actions-boundary.test.mjs holds
  // every action to it.
  ['src/app/actions/pipeline.ts', ['getActionAuthContext', 'assigned_to', 'Forbidden']],
  ['src/app/actions/settings.ts', ['getActionAuthContext', 'admin', 'operator']],
];
for (const [file, needles] of cases) {
  test(`${file} has auth/ownership evidence`, () => {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of needles) assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test("task GET and PATCH both enforce assignee ownership", () => {
  const text = fs.readFileSync("src/app/api/tasks/[id]/route.ts", "utf8");
  const matches = text.match(/\.eq\(['"]assignee_id['"],\s*user\.id\)/g) ?? [];
  assert.equal(matches.length, 2, "expected ownership filters on both GET and PATCH");
});
