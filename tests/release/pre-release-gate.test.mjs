import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('release gates use set -e-safe counter assignments', () => {
  for (const file of ['scripts/check-pre-release.sh', 'scripts/check-supply-chain.sh']) {
    const source = read(file);
    assert.match(source, /PASS=\$\(\(PASS \+ 1\)\)/, file);
    assert.match(source, /FAIL=\$\(\(FAIL \+ 1\)\)/, file);
    assert.doesNotMatch(source, /\(\(PASS\+\+\)\)|\(\(FAIL\+\+\)\)/, file);
    execFileSync('bash', ['-n', path.join(root, file)]);
  }
});

test('pre-release gate does not skip required checks or enable exceptions by default', () => {
  const source = read('scripts/check-pre-release.sh');
  assert.doesNotMatch(source, /_skip\(/);
  assert.doesNotMatch(source, /GATE=.*quick|mode=quick/);
  assert.match(source, /ALLOW_KNOWN_SUPPLY_CHAIN_EXCEPTIONS/);
  assert.doesNotMatch(source, /check-supply-chain\.sh --accept-known/);
  for (const check of [
    'scripts/check-schema-refs.py',
    'scripts/check-route-files.sh',
    'scripts/check-smoke.sh',
    'scripts/check-logs.sh',
    'scripts/check-supabase-boundaries.mjs',
    'scripts/check-db-static.mjs',
    'scripts/check-e2e-secrets.mjs',
    'scripts/check-workflows-yaml.sh',
    'scripts/check-database-types.mjs',
  ]) {
    assert.ok(source.includes(check), `required gate missing from release gate: ${check}`);
  }
});

test('Node 20 is the single declared release baseline and automatic CI stays disabled', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(read('.nvmrc').trim(), '20');
  assert.equal(pkg.engines.node, '>=20.0.0 <21.0.0');
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(ci, /\n\s*push:|\n\s*pull_request:/);
  assert.match(ci, /node-version: '20'/);
});
