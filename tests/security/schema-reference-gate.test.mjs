import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('schema reference gate detects multiline literal calls', () => {
  const output = execFileSync('python3', ['scripts/check-schema-refs.py', '--self-test'], {
    encoding: 'utf8',
  });

  assert.match(output, /Schema reference gate self-test passed/);
});
