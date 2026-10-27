#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const baselinePath = path.join(root, 'scripts/lint-baseline.json');
const ignoreArgs = [
  '--ignore-pattern', '.next/**',
  '--ignore-pattern', '.next.backup/**',
  '--ignore-pattern', 'node_modules/**',
  '--ignore-pattern', 'docs/**',
  '--ignore-pattern', 'supabase/**',
  '--ignore-pattern', 'coverage/**',
];

function runEslintJson() {
  const windowsNpxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const command = process.platform === 'win32' ? process.execPath : 'npx';
  const args = process.platform === 'win32'
    ? [windowsNpxCli, 'eslint', '.', '--format', 'json', ...ignoreArgs]
    : ['eslint', '.', '--format', 'json', ...ignoreArgs];
  const res = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 80,
  });
  if (res.error) {
    console.error(`eslint could not start: ${res.error.message}`);
    process.exit(1);
  }
  if (!(res.stdout ?? '').trim()) {
    console.error(res.stderr || 'eslint produced no JSON output');
    process.exit(res.status || 1);
  }
  return JSON.parse(res.stdout);
}
function rel(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}
export function fingerprint(message) {
  const normalizedRoot = root.replace(/\\/g, '/');
  return message
    .replace(/\\/g, '/')
    .replaceAll(normalizedRoot, '<root>')
    .replace(/\/home\/runner\/work\/[^/]+\/[^/]+/g, '<root>')
    .replace(/\/workspace\/[^/]+/g, '<root>')
    .replace(/\d+/g, '<n>')
    .replace(/'[^']*'/g, "'<value>'")
    .replace(/"[^"]*"/g, '"<value>"')
    // Line numbers are already erased above so that moving code does not read as a
    // new error. The gutter of an eslint code frame is padded to the width of the
    // widest line number in it, so the padding still carries the digit count: an
    // unrelated edit that pushes a finding from line 88 to line 144 widens
    // "\n     |" to "\n      |" and the finding looks new. Collapsing runs of
    // horizontal whitespace removes that last trace of position. It cannot hide an
    // error: the frame still contains the offending source line, and a finding that
    // collides with another one only makes the count for that key larger, which is
    // still compared against the baseline count.
    .replace(/[ \t]+/g, ' ');
}
function collect(results) {
  const entries = [];
  for (const file of results) {
    for (const msg of file.messages ?? []) {
      if (msg.severity !== 2) continue;
      entries.push({
        file: rel(file.filePath),
        ruleId: msg.ruleId ?? 'unknown',
        message: fingerprint(msg.message),
      });
    }
  }
  entries.sort((a, b) => `${a.file}\0${a.ruleId}\0${a.message}`.localeCompare(`${b.file}\0${b.ruleId}\0${b.message}`));
  return entries;
}
function counts(entries) {
  const out = new Map();
  for (const e of entries) {
    const k = `${e.file}\0${e.ruleId}\0${fingerprint(e.message)}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function main() {
  if (!fs.existsSync(baselinePath)) {
    console.error(`Missing lint baseline: ${path.relative(root, baselinePath)}`);
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const current = collect(runEslintJson());
  // Both sides go through counts(), which re-fingerprints, so a baseline recorded
  // before a fingerprint change is normalised the same way as the current run. The
  // committed baseline is never rewritten by a check.
  const baseCounts = counts(baseline.entries ?? []);
  const currentCounts = counts(current);
  const newFindings = [];
  for (const [key, count] of currentCounts) {
    const base = baseCounts.get(key) ?? 0;
    if (count > base) {
      const [file, ruleId, message] = key.split('\0');
      newFindings.push({ file, ruleId, message, added: count - base });
    }
  }
  if (newFindings.length) {
    console.error(`Lint baseline check failed: ${newFindings.reduce((n, f) => n + f.added, 0)} new error(s).`);
    for (const f of newFindings.slice(0, 50)) {
      console.error(`NEW ${f.file} ${f.ruleId} x${f.added}: ${f.message}`);
    }
    process.exit(1);
  }
  console.log(`Lint baseline check passed: ${current.length} current error(s), no new errors over baseline ${baseline.generated_at}.`);
}

// Importable for tests/lint-baseline-negative.test.mjs, which asserts the
// fingerprint's properties directly instead of only end-to-end.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
