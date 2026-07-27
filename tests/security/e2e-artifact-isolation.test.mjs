import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  REQUIRED_ARTIFACT_PATHS,
  findUnprotectedArtifacts,
} from '../../scripts/check-e2e-artifact-isolation.mjs';

test('E2E artifact isolation gate ignores every generated artifact class', () => {
  const output = execFileSync('node', ['scripts/check-e2e-artifact-isolation.mjs'], {
    encoding: 'utf8',
  });

  assert.match(output, /E2E artifact isolation gate passed/);
  assert.deepEqual(findUnprotectedArtifacts(), []);
  assert.equal(REQUIRED_ARTIFACT_PATHS.length > 0, true);
});

test('E2E artifact isolation gate rejects an unprotected artifact path', () => {
  assert.deepEqual(findUnprotectedArtifacts(['unprotected-artifacts/auth-state.json']), [
    'unprotected-artifacts/auth-state.json',
  ]);
});
