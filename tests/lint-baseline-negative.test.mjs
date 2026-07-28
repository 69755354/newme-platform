import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkLintBaseline } from '../scripts/check-lint-baseline.mjs';

function withFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-baseline-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/lint-baseline.json'), JSON.stringify({
    generated_at: '2026-07-28T00:00:00Z',
    entries: [{ file: 'src/example.ts', ruleId: 'demo/rule', message: 'existing error' }],
  }));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function eslintRun(root, messages, calls) {
  return (command) => {
    calls?.push(command);
    return {
      stdout: JSON.stringify([{ filePath: path.join(root, 'src/example.ts'), messages }]),
      stderr: '',
      status: messages.length ? 1 : 0,
    };
  };
}

const existing = [{ severity: 2, ruleId: 'demo/rule', message: 'existing error' }];

test('lint ratchet accepts an unchanged baseline through the project-local ESLint binary', () => {
  withFixture((root) => {
    const calls = [];
    const result = checkLintBaseline({ root, run: eslintRun(root, existing, calls), log: () => {}, error: () => {} });
    assert.deepEqual(result, { exitCode: 0, baselineErrors: 1, currentErrors: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], process.execPath);
  });
});

test('lint ratchet blocks an increased error count', () => {
  withFixture((root) => {
    const output = [];
    const result = checkLintBaseline({
      root,
      run: eslintRun(root, [...existing, { severity: 2, ruleId: 'demo/rule', message: 'new error' }]),
      log: () => {},
      error: (message) => output.push(message),
    });
    assert.equal(result.exitCode, 1);
    assert.match(output.join('\n'), /NEW src\/example\.ts demo\/rule/);
  });
});

test('lint ratchet makes reductions visible', () => {
  withFixture((root) => {
    const output = [];
    const result = checkLintBaseline({ root, run: eslintRun(root, []), log: (message) => output.push(message), error: () => {} });
    assert.deepEqual(result, { exitCode: 0, baselineErrors: 1, currentErrors: 0 });
    assert.match(output.join('\n'), /Lint debt reduced by 1 error/);
  });
});

test('lint ratchet fails closed on malformed baseline JSON', () => {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, 'scripts/lint-baseline.json'), '{');
    assert.throws(() => checkLintBaseline({ root, run: () => { throw new Error('must not run'); } }), /invalid lint baseline JSON/);
  });
});
