import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

import { fingerprint } from '../scripts/check-lint-baseline.mjs';

const runBaseline = () => spawnSync('node', ['scripts/check-lint-baseline.mjs'], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 20,
});

// An eslint code frame pads its gutter to the width of the widest line number in
// it, so the same finding at line 88 and at line 144 produced different text even
// after line numbers were erased — and the baseline reported an untouched finding
// as new whenever an unrelated edit crossed a digit boundary. These two frames are
// the real pair that exposed it.
const NARROW_GUTTER = 'x.tsx:<n>:<n>\n  88 |   useEffect(() => {\n> 89 |       setActiveStatus(quote.status);\n     |       ^^^ Avoid calling setState() directly within an effect';
const WIDE_GUTTER = 'x.tsx:<n>:<n>\n  142 |   useEffect(() => {\n> 144 |       setActiveStatus(quote.status);\n      |       ^^^ Avoid calling setState() directly within an effect';
assert.equal(
  fingerprint(NARROW_GUTTER),
  fingerprint(WIDE_GUTTER),
  'moving a finding to a longer line number must not read as a new error',
);
// It must still distinguish different findings in the same file, or the gate would
// stop counting them separately.
assert.notEqual(
  fingerprint(WIDE_GUTTER),
  fingerprint(WIDE_GUTTER.replace('setActiveStatus(quote.status)', 'setExpandedCategories(cats)')),
  'two different findings must not collapse into one fingerprint',
);

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
