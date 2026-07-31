import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../supabase/migrations/20260728081210_grant_sam26_runner_service_role_profiles_and_counts.sql', import.meta.url),
  'utf8',
);

test('SAM-26 grants only the service-role privileges used by the fixture runner', () => {
  assert.match(migration, /GRANT SELECT, UPDATE ON TABLE public\.profiles TO service_role;/);
  assert.match(
    migration,
    /GRANT SELECT ON TABLE\s+public\.leads,\s+public\.activities,\s+public\.tasks,\s+public\.business_events,\s+public\.notifications\s+TO service_role;/s,
  );

  assert.doesNotMatch(migration, /GRANT\s+ALL\b/i);
  assert.doesNotMatch(migration, /\bINSERT\b|\bDELETE\b/i);
  assert.doesNotMatch(migration, /\bTO\s+(?:anon|authenticated)\b/i);
});
