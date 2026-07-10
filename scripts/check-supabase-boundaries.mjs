#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const allowlistPath = path.join(root, 'scripts/supabase-boundary-allowlist.json');
const allowlist = fs.existsSync(allowlistPath) ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) : {};
const allowed = new Map(Object.entries(allowlist.allow ?? {}).map(([k, v]) => [k, v]));
const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ignore = new Set(['node_modules', '.next', '.next.backup', '.git', 'coverage']);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (exts.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}
function rel(file) { return path.relative(root, file).replaceAll(path.sep, '/'); }
function isBrowserReachable(r, text) {
  return r.startsWith('src/') && (text.split(/\r?\n/, 8).some(l => /['\"]use client['\"]/.test(l)) || r.includes('/components/') || r.includes('/shared/hooks/'));
}
function isServerOnlyPath(r) {
  return r.startsWith('src/app/api/') || r.startsWith('src/app/actions/') || r.includes('server') || r.startsWith('scripts/') || r.startsWith('tests/');
}
function add(findings, rule, file, lineNo, line, severity = 'error') {
  const key = `${rule}:${rel(file)}:${lineNo}`;
  const allow = allowed.get(key) ?? allowed.get(`${rule}:${rel(file)}`);
  findings.push({ rule, file: rel(file), lineNo, line: line.trim(), severity, allowed: Boolean(allow), reason: allow?.reason });
}

const findings = [];
for (const file of walk(root)) {
  const r = rel(file);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const browser = isBrowserReachable(r, text);
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (r === 'scripts/check-supabase-boundaries.mjs') return;
    if (/^\s*\/\//.test(line)) return;
    if (/SUPABASE_SERVICE_ROLE_KEY|service_role/i.test(line)) {
      if (browser) add(findings, 'service-role-in-browser-reachable-code', file, n, line);
      if (/NEXT_PUBLIC_.*(SERVICE|SECRET|ROLE|TOKEN|KEY)/i.test(line)) add(findings, 'sensitive-next-public-name', file, n, line);
    }
    if (/NEXT_PUBLIC_.*(SERVICE_ROLE|SECRET|TOKEN|PRIVATE)/i.test(line)) add(findings, 'sensitive-next-public-name', file, n, line);
    if (browser && /from\([^)]*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/.test(line)) {
      add(findings, 'client-side-supabase-mutation', file, n, line);
    }
    if (browser && /from\([^)]*\)\s*\.\s*select\s*\(/.test(line)) {
      add(findings, 'client-side-supabase-read', file, n, line);
    }
    if (/createClient\s*\([^\n]*(SERVICE_ROLE|serviceRole|serviceKey|srKey)/.test(line) && !isServerOnlyPath(r)) {
      add(findings, 'admin-client-outside-server-only', file, n, line);
    }
  });
  if (r.startsWith('src/lib/') && /SUPABASE_SERVICE_ROLE_KEY|service_role/i.test(text) && !/import ['\"]server-only['\"]/.test(text)) {
    add(findings, 'server-only-missing-for-admin-module', file, 1, 'module references service role without import "server-only"');
  }
}

let failures = 0;
for (const f of findings) {
  const status = f.allowed ? 'ALLOW' : 'FAIL';
  console.log(`${status} ${f.rule} ${f.file}:${f.lineNo} ${f.allowed ? `(${f.reason}) ` : ''}${f.line}`);
  if (!f.allowed && f.severity === 'error') failures++;
}
if (failures) {
  console.error(`Supabase boundary check failed: ${failures} unallowed finding(s).`);
  process.exit(1);
}
console.log(`Supabase boundary check passed with ${findings.length} finding(s), all allowed or informational.`);
