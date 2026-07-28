#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ignoreArgs = [
  '--ignore-pattern', '.next/**',
  '--ignore-pattern', '.next.backup/**',
  '--ignore-pattern', 'node_modules/**',
  '--ignore-pattern', 'docs/**',
  '--ignore-pattern', 'supabase/**',
  '--ignore-pattern', 'coverage/**',
];

function runEslintJson(root, run) {
  const eslintBin = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const res = run(process.execPath, [eslintBin, '.', '--format', 'json', ...ignoreArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 80,
  });
  if (res.error) {
    throw new Error(`eslint could not start: ${res.error.message}`);
  }
  const stdout = res.stdout ?? '';
  if (!stdout.trim()) {
    throw new Error((res.stderr ?? 'eslint produced no JSON output').trim());
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`eslint produced invalid JSON: ${error.message}`);
  }
}
function rel(root, filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}
function fingerprint(root, message) {
  const normalizedRoot = root.replace(/\\/g, '/');
  return message
    .replace(/\\/g, '/')
    .replaceAll(normalizedRoot, '<root>')
    .replace(/\/home\/runner\/work\/[^/]+\/[^/]+/g, '<root>')
    .replace(/\/workspace\/[^/]+/g, '<root>')
    .replace(/\d+/g, '<n>')
    .replace(/'[^']*'/g, "'<value>'")
    .replace(/"[^"]*"/g, '"<value>"');
}
function collect(root, results) {
  const entries = [];
  for (const file of results) {
    for (const msg of file.messages ?? []) {
      if (msg.severity !== 2) continue;
      entries.push({
        file: rel(root, file.filePath),
        ruleId: msg.ruleId ?? 'unknown',
        message: fingerprint(root, msg.message),
      });
    }
  }
  entries.sort((a, b) => `${a.file}\0${a.ruleId}\0${a.message}`.localeCompare(`${b.file}\0${b.ruleId}\0${b.message}`));
  return entries;
}
function counts(root, entries) {
  const out = new Map();
  for (const e of entries) {
    const k = `${e.file}\0${e.ruleId}\0${fingerprint(root, e.message)}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export function checkLintBaseline({ root = process.cwd(), run = spawnSync, log = console.log, error = console.error } = {}) {
  const baselinePath = path.join(root, 'scripts/lint-baseline.json');
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Missing lint baseline: ${path.relative(root, baselinePath)}`);
  }
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (parseError) {
    throw new Error(`invalid lint baseline JSON: ${parseError.message}`);
  }
  if (!Array.isArray(baseline.entries)) {
    throw new Error('invalid lint baseline: entries must be an array');
  }

  const current = collect(root, runEslintJson(root, run));
  const baseCounts = counts(root, baseline.entries);
  const currentCounts = counts(root, current);
  const newFindings = [];
  for (const [key, count] of currentCounts) {
    const base = baseCounts.get(key) ?? 0;
    if (count > base) {
      const [file, ruleId, message] = key.split('\0');
      newFindings.push({ file, ruleId, message, added: count - base });
    }
  }
  if (newFindings.length) {
    error(`Lint baseline check failed: ${newFindings.reduce((n, f) => n + f.added, 0)} new error(s).`);
    for (const finding of newFindings.slice(0, 50)) {
      error(`NEW ${finding.file} ${finding.ruleId} x${finding.added}: ${finding.message}`);
    }
    return { exitCode: 1, baselineErrors: baseline.entries.length, currentErrors: current.length };
  }

  log(`Lint baseline check passed: ${current.length} current error(s), no new errors over baseline ${baseline.generated_at}.`);
  const reduction = baseline.entries.length - current.length;
  if (reduction > 0) log(`Lint debt reduced by ${reduction} error(s).`);
  return { exitCode: 0, baselineErrors: baseline.entries.length, currentErrors: current.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = checkLintBaseline().exitCode;
  } catch (checkError) {
    console.error(`Lint baseline check failed: ${checkError.message}`);
    process.exitCode = 1;
  }
}
