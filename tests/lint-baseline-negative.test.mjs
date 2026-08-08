import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const runBaseline = () => spawnSync('node', ['scripts/check-lint-baseline.mjs'], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 20,
});

const clean = runBaseline();
assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
assert.match(clean.stdout, /Lint baseline check passed:/);

const fixture = `lint-baseline-negative-fixture-${process.pid}.js`;
fs.writeFileSync(fixture, 'const = ;\n');
try {
  const res = runBaseline();
  assert.notEqual(res.status, 0, 'lint baseline should block a new lint error');
  const output = `${res.stdout}\n${res.stderr}`;
  assert.match(output, /Lint baseline check failed: 1 new error\(s\)\./);
  assert.ok(output.includes(`NEW ${fixture} unknown x1:`), output);
  console.log('Negative lint baseline test passed: new lint error was blocked.');
} finally {
  fs.rmSync(fixture, { force: true });
}
