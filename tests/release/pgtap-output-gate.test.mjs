import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

test('pgTAP verifier exercises success, no-test, wrong-count, and failure fixtures', () => {
  const output = execFileSync('node', ['scripts/verify-pgtap-output.mjs', '--self-test'], {
    encoding: 'utf8',
  });
  assert.match(output, /pgTAP output verifier self-test passed/);
});

test('pgTAP verifier rejects NOTESTS on stdin despite a successful producer', () => {
  const result = spawnSync('node', ['scripts/verify-pgtap-output.mjs'], {
    encoding: 'utf8',
    input: 'Files=0, Tests=0, Result: NOTESTS\n',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reports no tests/);
});

test('pgTAP verifier accepts the real two-line pg_prove summary shape', () => {
  const result = spawnSync('node', ['scripts/verify-pgtap-output.mjs'], {
    encoding: 'utf8',
    input:
      'Files=1, Tests=14,  1 wallclock secs ( 0.01 usr  0.00 sys + 0.10 cusr  0.02 csys = 0.13 CPU)\nResult: PASS\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Files=1, Tests=14, Result=PASS/);
});

test('pgTAP verifier accepts the same summary with Windows line endings', () => {
  const result = spawnSync('node', ['scripts/verify-pgtap-output.mjs'], {
    encoding: 'utf8',
    input: 'Files=1, Tests=14,  1 wallclock secs\r\nResult: PASS\r\n',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('pgTAP verifier tolerates a PowerShell UTF-8 BOM', () => {
  const result = spawnSync('node', ['scripts/verify-pgtap-output.mjs'], {
    encoding: 'utf8',
    input: '\uFEFFFiles=1, Tests=14,  1 wallclock secs\r\nResult: PASS\r\n',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('pgTAP verifier rejects contradictory or duplicate summaries', () => {
  for (const input of [
    'Files=1, Tests=14, 1 wallclock secs\nResult: PASS\nFiles=2, Tests=15\nResult: FAIL\n',
    'Files=2, Tests=15\nResult: FAIL\nFiles=1, Tests=14, 1 wallclock secs\nResult: PASS\n',
    'Files=1, Tests=14, 1 wallclock secs\nResult: PASS\nResult: PASS\n',
  ]) {
    const result = spawnSync('node', ['scripts/verify-pgtap-output.mjs'], {
      encoding: 'utf8',
      input,
    });
    assert.notEqual(result.status, 0, input);
  }
});
