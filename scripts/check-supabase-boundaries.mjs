#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Self-test mode ───
if (process.argv.includes("--self-test")) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-test-"));
  const backupDir = path.join(tmp, ".next.backup.1784546503");
  fs.mkdirSync(backupDir, { recursive: true });
  // File that would trigger a violation if scanned
  fs.writeFileSync(path.join(backupDir, "fake.js"),
    'import { supabaseAdmin } from "@/lib/supabase-admin";\n' +
    'process.env.SUPABASE_SERVICE_ROLE_KEY;\n' +
    'supabaseAdmin.from("t").insert({});\n'
  );
  // Run the checker from tmp dir
  const { execSync } = await import("node:child_process");
  const script = process.argv[1];
  try {
    const out = execSync(`node "${script}"`, { cwd: tmp, timeout: 10000, encoding: "utf8" });
    if (out.includes("passed")) {
      console.log("SELF-TEST PASS: .next.backup.<timestamp> correctly ignored");
      fs.rmSync(tmp, { recursive: true, force: true });
      process.exit(0);
    }
    console.error("SELF-TEST FAIL: checker did not pass (unexpected)");
    console.error(out.slice(0, 500));
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  } catch (e) {
    console.error("SELF-TEST FAIL:", e.message?.slice(0, 200));
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

const root = process.cwd();
const allowlistPath = path.join(root, "scripts/supabase-boundary-allowlist.json");
const allowlist = fs.existsSync(allowlistPath)
  ? JSON.parse(fs.readFileSync(allowlistPath, "utf8"))
  : {};
const allowedCounts = new Map(Object.entries(allowlist.max_findings ?? {}));
const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const ignored = new Set(["node_modules", ".next", ".git", "coverage"]);

function isIgnoredDir(name) {
  if (ignored.has(name)) return true;
  // Catch .next.backup.<timestamp> / .next.backup-* variants created by deploy scripts
  if (name.startsWith(".next.backup")) return true;
  return false;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && isIgnoredDir(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (exts.includes(path.extname(entry.name))) out.push(file);
  }
  return out;
}
function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}
function resolveImport(fromFile, specifier, files) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  const candidates = [
    base,
    ...exts.map((ext) => base + ext),
    ...exts.map((ext) => path.join(base, "index" + ext)),
  ];
  return candidates.find((candidate) => files.has(path.resolve(candidate))) ?? null;
}
function importsOf(file, text, files) {
  const dependencies = [];
  const pattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const resolved = resolveImport(file, match[1] ?? match[2], files);
    if (resolved) dependencies.push(path.resolve(resolved));
  }
  return dependencies;
}
function isBrowserRoot(file, text) {
  const name = rel(file);
  return name.startsWith("src/") && (
    text.split(/\r?\n/, 8).some((line) => /["']use client["']/.test(line)) ||
    name.includes("/components/") ||
    name.includes("/shared/hooks/")
  );
}
function skipLeadingTrivia(text, start) {
  let index = start;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
      continue;
    }
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index + 2);
      return newline < 0 ? text.length : skipLeadingTrivia(text, newline + 1);
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      return end < 0 ? text.length : skipLeadingTrivia(text, end + 2);
    }
    break;
  }
  return index;
}
function readModulePrologue(text) {
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const directives = [];
  while (index < text.length) {
    index = skipLeadingTrivia(text, index);
    const quote = text[index];
    if (quote !== '"' && quote !== "'") break;
    const end = text.indexOf(quote, index + 1);
    if (end < 0) break;
    const value = text.slice(index + 1, end);
    let statementEnd = end + 1;
    while (text[statementEnd] === " " || text[statementEnd] === "\t") statementEnd += 1;
    if (text[statementEnd] === ";") statementEnd += 1;
    else if (statementEnd < text.length && text[statementEnd] !== "\r" && text[statementEnd] !== "\n") break;
    directives.push(value);
    index = statementEnd;
  }
  return { directives, index };
}
function hasServerOnlyBoundary(text) {
  const { directives, index } = readModulePrologue(text);
  if (directives.includes("use client")) return false;
  if (directives.includes("use server")) return true;
  const importStart = skipLeadingTrivia(text, index);
  return /^import\s+["']server-only["']\s*;?/.test(text.slice(importStart));
}
function isServerOnlyPath(name) {
  return name.startsWith("src/app/api/") ||
    name.startsWith("src/app/actions/") ||
    name.includes("server") ||
    name.startsWith("scripts/") ||
    name.startsWith("tests/");
}
function lineAt(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}
function add(findings, rule, file, lineNo, evidence) {
  findings.push({ rule, file: rel(file), lineNo, evidence: evidence.trim().replace(/\s+/g, " ") });
}

const fileList = walk(root).map((file) => path.resolve(file));
const fileSet = new Set(fileList);
const contents = new Map(fileList.map((file) => [file, fs.readFileSync(file, "utf8")]));
const browserReachable = new Set();
const queue = [];
for (const file of fileList) {
  if (isBrowserRoot(file, contents.get(file))) {
    browserReachable.add(file);
    queue.push(file);
  }
}
while (queue.length) {
  const file = queue.shift();
  for (const dependency of importsOf(file, contents.get(file), fileSet)) {
    if (hasServerOnlyBoundary(contents.get(dependency))) continue;
    if (!browserReachable.has(dependency)) {
      browserReachable.add(dependency);
      queue.push(dependency);
    }
  }
}

const findings = [];
for (const file of fileList) {
  const name = rel(file);
  if (name === "scripts/check-supabase-boundaries.mjs") continue;
  const text = contents.get(file);
  const browser = browserReachable.has(file);

  if (browser) {
    let offset = 0;
    while ((offset = text.indexOf(".from", offset)) >= 0) {
      let end = text.indexOf(";", offset);
      if (end < 0) end = Math.min(text.length, offset + 1200);
      const chain = text.slice(offset, Math.min(end, offset + 1200));
      const mutation = chain.match(/\.\s*(insert|update|upsert|delete)\s*\(/);
      if (mutation) add(findings, "client-side-supabase-mutation", file, lineAt(text, offset), chain);
      else if (/\.\s*select\s*\(/.test(chain)) add(findings, "client-side-supabase-read", file, lineAt(text, offset), chain);
      offset += 5;
    }
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/^\s*\/\//.test(line)) return;
    if (/SUPABASE_SERVICE_ROLE_KEY|service_role/i.test(line)) {
      if (browser) add(findings, "service-role-in-browser-reachable-code", file, index + 1, line);
      if (/NEXT_PUBLIC_.*(SERVICE|SECRET|ROLE|TOKEN|KEY)/i.test(line)) add(findings, "sensitive-next-public-name", file, index + 1, line);
    }
    if (/NEXT_PUBLIC_.*(SERVICE_ROLE|SECRET|TOKEN|PRIVATE)/i.test(line)) add(findings, "sensitive-next-public-name", file, index + 1, line);
    if (/createClient\s*\([^\n]*(SERVICE_ROLE|serviceRole|serviceKey|srKey)/.test(line) && !isServerOnlyPath(name)) {
      add(findings, "admin-client-outside-server-only", file, index + 1, line);
    }
  });
  if (name.startsWith("src/lib/") && /SUPABASE_SERVICE_ROLE_KEY|service_role/i.test(text) && !/import ["']server-only["']/.test(text)) {
    add(findings, "server-only-missing-for-admin-module", file, 1, 'module references service role without import "server-only"');
  }
}

const counts = new Map();
for (const finding of findings) {
  const key = `${finding.rule}:${finding.file}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
let failures = 0;
for (const [key, count] of counts) {
  const maximum = allowedCounts.get(key) ?? 0;
  const status = count <= maximum ? "ALLOW" : "FAIL";
  console.log(`${status} ${key} count=${count} baseline=${maximum}`);
  if (count > maximum) failures += count - maximum;
}
for (const finding of findings) {
  const key = `${finding.rule}:${finding.file}`;
  if ((counts.get(key) ?? 0) > (allowedCounts.get(key) ?? 0)) {
    console.log(`  ${finding.file}:${finding.lineNo} ${finding.evidence}`);
  }
}
if (failures) {
  console.error(`Supabase boundary check failed: ${failures} finding(s) over the reviewed baseline.`);
  process.exit(1);
}
console.log(`Supabase boundary check passed with ${findings.length} finding(s); no rule/file count exceeded the reviewed baseline.`);
