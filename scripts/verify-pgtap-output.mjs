#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const EXPECTED_COUNTS = /^Files=1, Tests=14,/m;
const EXPECTED_RESULT = /^Result: PASS\r?$/m;

export function verifyPgTapOutput(output) {
  const normalizedOutput = output.replace(/^\uFEFF/, '');
  if (/NOTESTS|Files=0/.test(normalizedOutput)) {
    throw new Error('database test output reports no tests');
  }
  const lines = normalizedOutput.split(/\r?\n/);
  const countLines = lines.filter((line) => line.startsWith('Files='));
  const resultLines = lines.filter((line) => line.startsWith('Result:'));
  if (
    countLines.length !== 1 ||
    resultLines.length !== 1 ||
    !EXPECTED_COUNTS.test(countLines[0]) ||
    !EXPECTED_RESULT.test(resultLines[0])
  ) {
    throw new Error('database test output is not exactly one file, 14 tests, PASS');
  }
}

function selfTest() {
  verifyPgTapOutput(
    'Files=1, Tests=14,  1 wallclock secs ( 0.01 usr  0.00 sys + 0.10 cusr  0.02 csys = 0.13 CPU)\nResult: PASS\n',
  );
  for (const invalid of [
    'Files=0, Tests=0, Result: NOTESTS\n',
    'Files=1, Tests=13, Result: PASS\n',
    'Files=1, Tests=14, Result: FAIL\n',
    'Files=1, Tests=14, 1 wallclock secs\nResult: PASS\nFiles=2, Tests=15\nResult: FAIL\n',
    'Files=2, Tests=15\nResult: FAIL\nFiles=1, Tests=14, 1 wallclock secs\nResult: PASS\n',
    'Files=1, Tests=14, 1 wallclock secs\nResult: PASS\nResult: PASS\n',
  ]) {
    assertRejected(invalid);
  }
  console.log('pgTAP output verifier self-test passed');
}

function assertRejected(output) {
  try {
    verifyPgTapOutput(output);
  } catch {
    return;
  }
  throw new Error(`invalid pgTAP fixture was accepted: ${JSON.stringify(output)}`);
}

try {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    verifyPgTapOutput(readFileSync(0, 'utf8'));
    console.log('pgTAP output verified: Files=1, Tests=14, Result=PASS');
  }
} catch (error) {
  console.error(`pgTAP output verification failed: ${error.message}`);
  process.exitCode = 1;
}
