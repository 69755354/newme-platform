import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REQUIRED_ARTIFACT_PATHS,
  findTrackedArtifacts,
  findUnprotectedArtifacts,
} from '../../scripts/check-e2e-artifact-isolation.mjs';

test('E2E artifact isolation gate ignores every generated artifact class', () => {
  const output = execFileSync('node', ['scripts/check-e2e-artifact-isolation.mjs'], {
    encoding: 'utf8',
  });

  assert.match(output, /E2E artifact isolation gate passed/);
  assert.deepEqual(findUnprotectedArtifacts(), []);
  assert.ok(REQUIRED_ARTIFACT_PATHS.length > 0);
});

test('E2E artifact isolation gate rejects an unprotected artifact path', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'newme-e2e-artifact-gate-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot });
    writeFileSync(join(fixtureRoot, '.gitignore'), 'playwright-report/\n', 'utf8');

    assert.deepEqual(
      findUnprotectedArtifacts(
        ['playwright-report/index.html', 'unprotected-artifacts/auth-state.json'],
        fixtureRoot,
      ),
      ['unprotected-artifacts/auth-state.json'],
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('E2E artifact isolation gate rejects ignored artifacts forced into the index', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'newme-e2e-forced-artifact-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot });
    writeFileSync(
      join(fixtureRoot, '.gitignore'),
      'e2e/screenshots/\n*.trace.zip\ntrace.zip\n.playwright/\n',
      'utf8',
    );
    execFileSync('git', ['add', '.gitignore'], { cwd: fixtureRoot });
    execFileSync('git', ['apply', '--unsafe-paths', '-'], {
      cwd: fixtureRoot,
      input:
        'diff --git a/e2e/screenshots/failure.png b/e2e/screenshots/failure.png\nnew file mode 100644\nindex 0000000..e69de29\n' +
        'diff --git a/e2e/failure.trace.zip b/e2e/failure.trace.zip\nnew file mode 100644\nindex 0000000..e69de29\n' +
        'diff --git a/.playwright/state.json b/.playwright/state.json\nnew file mode 100644\nindex 0000000..e69de29\n',
    });
    execFileSync(
      'git',
      [
        'add',
        '-f',
        '.playwright/state.json',
        'e2e/screenshots/failure.png',
        'e2e/failure.trace.zip',
      ],
      { cwd: fixtureRoot },
    );

    assert.deepEqual(findUnprotectedArtifacts(undefined, fixtureRoot), [
      'e2e/.auth/boss.json',
      'e2e/auth-state.json',
      'e2e/nested/auth_state.zip',
      'e2e/storage-state.json',
      'e2e/nested/storage_state.zip',
      'e2e/session.json',
      'e2e/nested/session-state.zip',
      'e2e-results.json',
      'playwright-report/index.html',
      'test-results/example/test-failed-1.png',
      'blob-report/report.zip',
    ]);
    assert.deepEqual(findTrackedArtifacts(fixtureRoot), [
      '.playwright/state.json',
      'e2e/failure.trace.zip',
      'e2e/screenshots/failure.png',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
