#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  const res = spawnSync('npx', ['eslint', '.', '--format', 'json', ...ignoreArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 80,
  });
  if (!res.stdout.trim()) {
    console.error(res.stderr || 'eslint produced no JSON output');
    process.exit(res.status || 1);
  }
  return JSON.parse(res.stdout);
}
function rel(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}
function fingerprint(message) {
  return message.replace(/\d+/g, '<n>').replace(/'[^']*'/g, "'<value>'").replace(/"[^"]*"/g, '"<value>"');
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
    const k = `${e.file}\0${e.ruleId}\0${e.message}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

if (!fs.existsSync(baselinePath)) {
  console.error(`Missing lint baseline: ${path.relative(root, baselinePath)}`);
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const current = collect(runEslintJson());
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
