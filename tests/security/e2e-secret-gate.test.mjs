import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('E2E secret gate rejects a generated credential fixture', () => {
  const output = execFileSync('node', ['scripts/check-e2e-secrets.mjs', '--self-test'], {
    encoding: 'utf8',
  });

  assert.match(output, /E2E secret gate self-test passed/);
});
