#!/usr/bin/env node
// S6 · fail on user-visible English that bypasses the dictionary.
//
// t() keys are already checked by tests/i18n/translation-key-coverage.test.mjs
// (missing key => the key path shows on screen). This script covers the other
// half reported by the 2026-11 review (4d section 4): literal English written
// straight into JSX text, into toast(...) calls, or into placeholder / title /
// aria-label attributes, which stays English in the Chinese interface.
//
// Existing debt is frozen in tests/i18n/hardcoded-english-baseline.json
// (per-file counts). A file may only go DOWN; a new file must have zero.
// Run `node scripts/check-i18n-hardcoded.mjs --write-baseline` after removing
// debt to lock the lower numbers in. Exit 1 on any regression.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_DIRS = ["src/app", "src/components"];
const BASELINE = path.join(ROOT, "tests/i18n/hardcoded-english-baseline.json");
// Words that read the same in both interfaces (brands, units, formats).
const ALLOWED = new Set([
  "NewMe", "NewMe OS", "OS", "WhatsApp", "KNX", "AED", "VAT", "CRM", "ID", "PDF", "CSV", "Excel", "Meta", "Facebook",
  "Instagram", "Google", "TikTok", "ROI", "ROAS", "KPI", "FB", "ins", "EN", "OK", "N/A", "HVAC", "CCTV", "BUS",
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });
}

function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function isEnglishPhrase(text) {
  const s = text.trim();
  if (!s || ALLOWED.has(s)) return false;
  if (/[一-鿿]/.test(s)) return false; // already Chinese (or bilingual)
  if (/^[\W\d_]*$/.test(s)) return false; // symbols / numbers only
  if (/^[a-z0-9_.-]+$/.test(s) && s.includes(".")) return false; // a key path
  if (/^(https?:|\/|#|@|\+?\d)/.test(s)) return false; // urls, paths, phone formats
  return /[A-Za-z]{2,}/.test(s);
}

export function findHardcodedEnglish(source) {
  const src = stripComments(source);
  const hits = [];
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  // 1. JSX text between tags: >Some words<
  for (const m of src.matchAll(/>([^<>{}`=;]*[A-Za-z][^<>{}`=;]*)</g)) {
    const text = m[1];
    if (src[m.index - 1] === "=") continue; // arrow function return type: () => Promise<...>
    if (/=>|&&|\|\||\?\s|\bconst\b|\breturn\b|[|&]|^\s*[,()]|(^|\n)\s*\w+\??:/.test(text)) continue; // types / code, not text
    if (text.includes("\n") && text.trim().split(/\s+/).length > 12) continue;
    if (isEnglishPhrase(text)) hits.push({ line: lineOf(m.index), kind: "jsx-text", text: text.trim() });
  }
  // 2. toast.x("English") / toast("English")
  for (const m of src.matchAll(/\btoast(?:\.(?:error|success|info|warning|message|loading))?\(\s*(["'`])((?:(?!\1).)*)\1/g)) {
    if (isEnglishPhrase(m[2].replace(/\$\{[^}]*\}/g, ""))) hits.push({ line: lineOf(m.index), kind: "toast", text: m[2] });
  }
  // 3. placeholder / title / aria-label / alt literals
  for (const m of src.matchAll(/\b(placeholder|title|aria-label|alt)=(["'])([^"']*)\2/g)) {
    if (isEnglishPhrase(m[3])) hits.push({ line: lineOf(m.index), kind: m[1], text: m[3] });
  }
  return hits;
}

export function scan(root = ROOT) {
  const result = {};
  for (const d of SCAN_DIRS) {
    for (const file of walk(path.join(root, d))) {
      const hits = findHardcodedEnglish(fs.readFileSync(file, "utf8"));
      if (hits.length) result[path.relative(root, file)] = hits;
    }
  }
  return result;
}

export function compare(current, baseline) {
  const regressions = [];
  for (const [file, hits] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (hits.length > allowed) regressions.push({ file, allowed, found: hits.length, hits });
  }
  return regressions;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const current = scan();
  if (process.argv.includes("--write-baseline")) {
    const counts = Object.fromEntries(Object.entries(current).sort().map(([f, h]) => [f, h.length]));
    fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
    console.log(`baseline written: ${Object.values(counts).reduce((a, b) => a + b, 0)} findings in ${Object.keys(counts).length} files`);
    process.exit(0);
  }
  if (process.argv.includes("--list")) {
    for (const [f, hits] of Object.entries(current)) for (const h of hits) console.log(`${f}:${h.line} [${h.kind}] ${h.text}`);
    process.exit(0);
  }
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
  const regressions = compare(current, baseline);
  for (const r of regressions) {
    console.error(`${r.file}: ${r.found} hard-coded English string(s), baseline allows ${r.allowed}`);
    for (const h of r.hits) console.error(`  line ${h.line} [${h.kind}] ${h.text}`);
  }
  if (regressions.length) process.exit(1);
  console.log("i18n hard-coded English: no regression against baseline");
}
