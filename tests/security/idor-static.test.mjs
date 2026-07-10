import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const cases = [
  ['src/app/api/leads/[id]/quality/route.ts', ['getAuthProfile', 'assigned_to', '403']],
  ['src/app/api/contracts/[id]/route.ts', ['auth.getUser', 'sales_id', '403']],
  ['src/app/api/payments/[id]/confirm/route.ts', ['auth.getUser', 'admin', 'finance']],
  ['src/app/api/tasks/[id]/route.ts', ['auth.getUser', 'assignee_id', '404']],
  ['src/app/actions/pipeline.ts', ['auth.getUser', 'assigned_to', 'Forbidden']],
  ['src/app/actions/settings.ts', ['auth.getUser', 'admin', 'operator']],
];
for (const [file, needles] of cases) {
  test(`${file} has auth/ownership evidence`, () => {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of needles) assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
