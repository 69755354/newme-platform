#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const normalized = (value) => value.replaceAll(path.sep, '/');
const artifactPath = /(^|\/)(e2e\/\.auth\/|playwright-report\/|test-results\/|blob-report\/|e2e-results\.json$|e2e\/.*(?:storage[-_]?state|auth[-_]?state|session).*(?:\.json|\.zip)$)/i;
const e2eSourcePath = /(^|\/)(e2e\/|playwright\.config\.[cm]?[jt]s$)/i;
const textSourcePath = /\.(?:[cm]?[jt]sx?|json|ya?ml|env)$/i;
const passwordLiteral = /\b(?:password|passwd|pwd)\b\s*[:=]\s*(['"`])(?=.{6,}\1)/i;
const jwtLikeToken = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

function scanFile(filePath, displayPath = filePath) {
  const violations = [];
  const relativePath = normalized(displayPath);

  if (artifactPath.test(relativePath)) {
    violations.push('tracked authentication or Playwright artifact');
    return violations;
  }

  if (!textSourcePath.test(relativePath)) return violations;

  const content = readFileSync(filePath, 'utf8');
  if (e2eSourcePath.test(relativePath) && passwordLiteral.test(content)) {
    violations.push('literal E2E password assignment');
  }
  if (jwtLikeToken.test(content)) violations.push('JWT-like session token');
  if (privateKey.test(content)) violations.push('private key material');
  return violations;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function main() {
  if (process.argv.includes('--self-test')) {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), 'newme-e2e-secret-gate-'));
    try {
      const fixturePath = path.join(fixtureDir, 'credential.fixture.ts');
      const key = ['pass', 'word'].join('');
      writeFileSync(fixturePath, `export const ${key} = "${['example', 'credential'].join('-')}";\n`);
      const violations = scanFile(fixturePath, 'e2e/credential.fixture.ts');
      if (!violations.includes('literal E2E password assignment')) {
        throw new Error('negative credential fixture was not rejected');
      }
      console.log('E2E secret gate self-test passed');
      return;
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }

  const violations = [];
  for (const relativePath of trackedFiles()) {
    const filePath = path.join(repoRoot, relativePath);
    for (const reason of scanFile(filePath, relativePath)) {
      violations.push(`${relativePath}: ${reason}`);
    }
  }

  if (violations.length > 0) {
    console.error('E2E secret gate failed:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  console.log('E2E secret gate passed');
}

main();
