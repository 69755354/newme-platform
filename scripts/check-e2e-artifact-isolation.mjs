#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

export const REQUIRED_ARTIFACT_PATHS = [
  'e2e/.auth/boss.json',
  'e2e/auth-state.json',
  'e2e/nested/auth_state.zip',
  'e2e/storage-state.json',
  'e2e/nested/storage_state.zip',
  'e2e/session.json',
  'e2e/nested/session-state.zip',
  'e2e/screenshots/failure.png',
  'e2e-results.json',
  'playwright-report/index.html',
  'test-results/example/test-failed-1.png',
  'blob-report/report.zip',
  '.playwright/state.json',
  'e2e/failure.trace.zip',
  'e2e/trace.zip',
];

const TRACKED_ARTIFACT_PATH = /(^|\/)(?:\.playwright\/|e2e\/\.auth\/|e2e\/.*(?:auth[-_]?state|storage[-_]?state|session)[^/]*\.(?:json|zip)$|e2e\/screenshots\/|e2e-results\.json$|playwright-report\/|test-results\/|blob-report\/|(?:[^/]*\.)?trace\.zip$)/i;

function isIgnored(relativePath, cwd) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', relativePath], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

export function findUnprotectedArtifacts(
  paths = REQUIRED_ARTIFACT_PATHS,
  cwd = process.cwd(),
) {
  return paths.filter((relativePath) => !isIgnored(relativePath, cwd));
}

export function findTrackedArtifacts(cwd = process.cwd()) {
  return execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((relativePath) => relativePath.replaceAll('\\', '/'))
    .filter((relativePath) => TRACKED_ARTIFACT_PATH.test(relativePath));
}

const unprotectedArtifacts = findUnprotectedArtifacts();
const trackedArtifacts = findTrackedArtifacts();
if (unprotectedArtifacts.length > 0 || trackedArtifacts.length > 0) {
  console.error('E2E artifact isolation gate failed:');
  for (const artifact of unprotectedArtifacts) {
    console.error(`- ${artifact}: not ignored`);
  }
  for (const artifact of trackedArtifacts) {
    console.error(`- ${artifact}: tracked generated artifact`);
  }
  process.exit(1);
}

console.log('E2E artifact isolation gate passed');
