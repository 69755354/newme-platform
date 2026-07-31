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
  'e2e/failure.trace.zip',
  'e2e/trace.zip',
];

function isIgnored(relativePath) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', relativePath], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

export function findUnprotectedArtifacts(paths = REQUIRED_ARTIFACT_PATHS) {
  return paths.filter((relativePath) => !isIgnored(relativePath));
}

const unprotectedArtifacts = findUnprotectedArtifacts();
if (unprotectedArtifacts.length > 0) {
  console.error('E2E artifact isolation gate failed:');
  for (const artifact of unprotectedArtifacts) {
    console.error(`- ${artifact}: not ignored`);
  }
  process.exit(1);
}

console.log('E2E artifact isolation gate passed');
