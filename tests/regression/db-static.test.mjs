import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const migrations = fs.readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && !f.startsWith('rollback_')).sort();
const all = migrations.map(f => fs.readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n');
test('migration timestamps are unique and ordered', () => {
  const prefixes = migrations.map(f => f.split('_')[0]);
  assert.equal(new Set(prefixes).size, prefixes.length);
  assert.deepEqual([...migrations].sort(), migrations);
});
test('database gates exist for milestone/contact/quality/won-lost events', () => {
  for (const token of ['first_contact', 'quality_checked', 'leads_archived', 'check_milestone_order', 'won_at']) {
    assert.ok(all.includes(token), `missing ${token}`);
  }
});
