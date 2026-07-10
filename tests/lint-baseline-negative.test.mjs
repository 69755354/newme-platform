import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const fixture = 'lint-baseline-negative-fixture.js';
fs.writeFileSync(fixture, 'const = ;\n');
try {
  const res = spawnSync('node', ['scripts/check-lint-baseline.mjs'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  assert.notEqual(res.status, 0, 'lint baseline should block a new lint error');
  assert.match(`${res.stdout}\n${res.stderr}`, /Lint baseline check failed|NEW/);
  console.log('Negative lint baseline test passed: new lint error was blocked.');
} finally {
  fs.rmSync(fixture, { force: true });
}
