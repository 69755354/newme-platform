import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const library = source('../../scripts/lib/staging-sam26-fixture-identity.mjs');
const runner = source('../../scripts/run-staging-sam26-fixtures.mjs');
const cleanup = source('../../scripts/cleanup-staging-sam26-identities.mjs');

const roles = ['boss', 'admin', 'operator', 'sales', 'finance', 'designer'];

test('SAM-26 entries delegate to the shared hard-pinned staging implementation', () => {
  assert.match(runner, /from '\.\/lib\/staging-sam26-fixture-identity\.mjs'/);
  assert.match(cleanup, /from '\.\/lib\/staging-sam26-fixture-identity\.mjs'/);

  assert.match(library, /bfsiibofuzoglziltgyd/);
  assert.match(library, /NEWME_STAGING_SUPABASE_REF/);
  assert.match(library, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(library, /STAGING_DATABASE_URL/);
  assert.match(library, /SAM26_FAIL_CLOSED/);
});

test('SAM-26 identity creation has double app-metadata markers and never logs credentials', () => {
  assert.match(library, /fixture_scope: FIXTURE_SCOPE/);
  assert.match(library, /fixture_kind: FIXTURE_KIND/);
  assert.match(library, /auth\.admin\.listUsers/);
  assert.match(library, /auth\.admin\.createUser/);
  assert.match(library, /auth\.admin\.updateUserById/);
  assert.match(library, /auth\.admin\.deleteUser/);
  assert.match(library, /randomBytes\(32\)/);
  assert.doesNotMatch(library, /console\.(log|error).*password/i);
  assert.doesNotMatch(library, /console\.(log|error).*SUPABASE_SERVICE_ROLE_KEY/i);
  assert.doesNotMatch(library, /\b(insert|update|delete)\s+(?:into\s+)?auth\.users\b/i);

  for (const role of roles) assert.match(library, new RegExp(`'${role}'`));
});

test('SAM-26 runner verifies trigger-backed profiles then proves seed idempotency', () => {
  assert.match(library, /auth-user creation did not produce a profile through the expected trigger/);
  assert.match(library, /profile-trigger verification failed/);
  assert.equal((runner.match(/await runFixtureSql\(database, seedPath\)/g) || []).length, 2);
  assert.match(runner, /leads: 6, activities: 2, tasks: 2, business_events: 2, notifications: 6/);
});

test('SAM-26 cleanup removes core fixtures before identities and fails on references', () => {
  const coreCleanupIndex = cleanup.indexOf('await runFixtureSql(database, cleanupPath)');
  const identityCleanupIndex = cleanup.indexOf('await deleteFixtureIdentities(admin)');
  assert.ok(coreCleanupIndex >= 0 && identityCleanupIndex > coreCleanupIndex);
  assert.match(cleanup, /assertFixtureProfilesDeleted/);
  assert.match(library, /fixture identities still have public foreign-key references/);
  assert.doesNotMatch(cleanup, /\bTRUNCATE\b/i);
});