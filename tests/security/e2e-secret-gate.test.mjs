import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('E2E secret gate rejects a generated credential fixture', () => {
  const output = execFileSync('node', ['scripts/check-e2e-secrets.mjs', '--self-test'], {
    encoding: 'utf8',
  });

  assert.match(output, /E2E secret gate self-test passed/);
});

test('E2E secret gate scans tracked and untracked source while tolerating deletions', () => {
  const source = readFileSync(
    new URL('../../scripts/check-e2e-secrets.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /'--cached', '--others', '--exclude-standard'/);
  assert.match(source, /!existsSync\(filePath\) \|\| !statSync\(filePath\)\.isFile\(\)/);
});
