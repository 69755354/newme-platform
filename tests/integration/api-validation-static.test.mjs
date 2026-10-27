import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('weekly trends and pipeline list derive period server-side or validate fixed ranges', () => {
  const weekly = fs.readFileSync('src/app/api/dashboard/weekly-trends/route.ts', 'utf8');
  assert.match(weekly, /past 12 weeks|for \(let i = 11; i >= 0; i--\)/);
  const pipeline = fs.readFileSync('src/app/api/pipeline/list/route.ts', 'utf8');
  assert.match(pipeline, /period/);
  assert.match(pipeline, /assigned_to|sales_id/);
});
test('quality route validates allowed quality values and poor reason', () => {
  const text = fs.readFileSync('src/app/api/leads/[id]/quality/route.ts', 'utf8');
  assert.match(text, /poor.+normal.+good/s);
  assert.match(text, /poor_reason is required/);
  assert.match(text, /getRequestAuthContext\(req\)/);
  assert.match(text, /applyRequestAuthCookies\(context, NextResponse\.json/);
  assert.doesNotMatch(text, /createServerSupabase/);
  assert.doesNotMatch(text, /createServerClient/);
});
