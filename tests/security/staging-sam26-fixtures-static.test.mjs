import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const seed = readFileSync(fileURLToPath(new URL('../../scripts/seed-staging-sam26-fixtures.sql', import.meta.url)), 'utf8');
const cleanup = readFileSync(fileURLToPath(new URL('../../scripts/cleanup-staging-sam26-fixtures.sql', import.meta.url)), 'utf8');

const requiredRoles = ['boss', 'admin', 'operator', 'sales', 'finance', 'designer'];
const fixtureTables = ['leads', 'activities', 'tasks', 'business_events', 'notifications'];

test('SAM-26 seed is pinned to the staging project and fails closed for missing roles', () => {
  assert.match(seed, /app\.newme\.staging_fixture_target/);
  assert.match(seed, /bfsiibofuzoglziltgyd/);
  assert.match(seed, /require pre-provisioned active staging profiles/i);

  for (const role of requiredRoles) {
    assert.match(seed, new RegExp(`'${role}'`));
  }
});

test('SAM-26 seed never creates or rewrites identities', () => {
  assert.doesNotMatch(seed, /\b(insert|update|delete)\s+(?:into\s+)?auth\.users\b/i);
  assert.doesNotMatch(seed, /\b(insert|update|delete)\s+(?:into\s+)?public\.profiles\b/i);
  assert.equal((seed.match(/ON CONFLICT \(id\) DO NOTHING/g) || []).length, 5);

  for (const table of fixtureTables) {
    assert.match(seed, new RegExp(`INSERT INTO public\\.${table}`, 'i'));
  }
});

test('SAM-26 uses only transfer-candidate roles as lead assignees', () => {
  assert.match(seed, /\('finance',\s*'sales',\s*'8a260001-/);
  assert.match(seed, /\('designer',\s*'operator',\s*'8a260001-/);
  assert.match(seed, /JOIN role_profiles AS fixture_profiles ON fixture_profiles\.role = fixture_rows\.role/);
  assert.match(seed, /JOIN role_profiles AS assignee_profiles ON assignee_profiles\.role = fixture_rows\.assignee_role/);
  assert.match(seed, /assignee_profiles\.id,\s*assignee_profiles\.id,\s*fixture_profiles\.id,\s*fixture_profiles\.id/s);
  assert.doesNotMatch(seed, /\('(?:finance|designer)',\s*'(?:finance|designer)',\s*'8a260001-/);
});

test('SAM-26 cleanup has the same staging guard and only deletes scoped fixtures', () => {
  assert.match(cleanup, /app\.newme\.staging_fixture_target/);
  assert.match(cleanup, /bfsiibofuzoglziltgyd/);
  assert.doesNotMatch(cleanup, /\bTRUNCATE\b/i);
  assert.doesNotMatch(cleanup, /\bDELETE FROM\s+(?:auth\.users|public\.profiles)\b/i);

  for (const table of fixtureTables) {
    assert.match(cleanup, new RegExp(`DELETE FROM public\\.${table}`, 'i'));
  }

  assert.match(cleanup, /fixture_scope.*staging-sam26/s);
  assert.match(cleanup, /title = '\[SAM-26\] synthetic lead assignment'/);
});
