#!/usr/bin/env node
/**
 * OS fix S20: what the data-import gate depends on, checked in one place.
 *
 * The spreadsheet import program and its data bundle are never part of this repository (the
 * repository is public and the bundle holds customer data). They live in one root-only
 * directory on the production host, /opt/newme-import/current, and the release gate refuses to
 * run them unless this check passes:
 *
 *   - the directory is a real directory owned by root with mode 0700, and so is nothing else
 *     in the way (parent not writable by group/other, no symlinks, no extra entries);
 *   - the four files are exactly import_sheets.mjs, rollback_import.mjs, bundle.json and
 *     MANIFEST; each is a plain file owned by root, not readable by anyone else, single link;
 *   - MANIFEST (sha256sum format) lists exactly the three payload files and every hash matches;
 *   - the two programs carry no connection string and no literal password or key (the database
 *     is reached through NEWME_IMPORT_DB_URL, which the gate fills from the migration URL file);
 *   - (repository mode) no data bundle, import program or run artifact is tracked in git.
 *
 * It reports locations and rule names only, never file contents.
 *
 *   node scripts/check-s20-import-gate.mjs [--import-dir DIR] [--repo-root DIR]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const IMPORT_DIR_DEFAULT = "/opt/newme-import/current";
export const PROGRAM_FILES = Object.freeze(["import_sheets.mjs", "rollback_import.mjs"]);
export const DATA_FILE = "bundle.json";
export const PAYLOAD_FILES = Object.freeze([...PROGRAM_FILES, DATA_FILE]);
export const MANIFEST_FILE = "MANIFEST";
export const ALLOWED_ENTRIES = Object.freeze([...PAYLOAD_FILES, MANIFEST_FILE]);

const HEX64 = /^[0-9a-f]{64}$/;

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Parse sha256sum output. Returns {hashes: Map<name,hex>, problems}. */
export function parseManifest(text) {
  const problems = [];
  const hashes = new Map();
  const lines = String(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) {
      problems.push("MANIFEST has a line that is not sha256sum format");
      continue;
    }
    if (hashes.has(match[2])) problems.push(`MANIFEST lists ${match[2]} twice`);
    hashes.set(match[2], match[1]);
  }
  for (const name of PAYLOAD_FILES) {
    if (!hashes.has(name)) problems.push(`MANIFEST does not list ${name}`);
  }
  for (const name of hashes.keys()) {
    if (!PAYLOAD_FILES.includes(name)) problems.push(`MANIFEST lists an unexpected file ${name}`);
  }
  return { hashes, problems: [...new Set(problems)] };
}

/**
 * Patterns a program must not contain. Each is a rule name plus a test; findings carry the rule
 * name only. The programs get the database through NEWME_IMPORT_DB_URL; anything that looks like
 * a credential written into the file itself is refused.
 */
export const SECRET_RULES = Object.freeze([
  { name: "connection string", test: (text) => /\bpostgres(?:ql)?:\/\//i.test(text) },
  { name: "literal password", test: (text) => /\b(?:password|passwd|pwd)\b["']?\s*[:=]\s*["'`][^"'`\s]{3,}["'`]/i.test(text) },
  { name: "json web token", test: (text) => /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\./.test(text) },
  { name: "service key literal", test: (text) => /\b(?:sb_secret_|sbp_)[A-Za-z0-9_-]{16,}/.test(text) },
  { name: "private key block", test: (text) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) },
]);

export function scanProgramText(text) {
  return SECRET_RULES.filter((rule) => rule.test(text)).map((rule) => rule.name);
}

const modeOf = (stat) => stat.mode & 0o7777;

/**
 * Judge the import directory. Returns {problems, bundleSha256, manifestSha256, hashes}.
 * expectedUid is 0 (root) on the host; tests pass their own uid.
 */
export function verifyImportDir(dir, { expectedUid = 0 } = {}) {
  const problems = [];
  const result = { problems, bundleSha256: null, manifestSha256: null, hashes: {} };
  let dirStat;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    problems.push("the import directory does not exist");
    return result;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    problems.push("the import directory is not a real directory");
    return result;
  }
  if (dirStat.uid !== expectedUid) problems.push("the import directory is not owned by root");
  if (modeOf(dirStat) !== 0o700) problems.push("the import directory mode must be 0700");
  try {
    const parent = fs.lstatSync(path.dirname(dir));
    if (parent.isSymbolicLink() || !parent.isDirectory()) problems.push("the import parent is not a real directory");
    else {
      if (parent.uid !== expectedUid) problems.push("the import parent directory is not owned by root");
      if ((modeOf(parent) & 0o022) !== 0) problems.push("the import parent directory is writable by group or others");
    }
  } catch {
    problems.push("the import parent directory cannot be read");
  }
  if (problems.length) return result;

  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    if (!ALLOWED_ENTRIES.includes(name)) problems.push(`unexpected entry in the import directory: ${name}`);
  }
  for (const name of ALLOWED_ENTRIES) {
    if (!entries.includes(name)) problems.push(`${name} is missing from the import directory`);
  }
  if (problems.length) return result;

  const contents = {};
  for (const name of ALLOWED_ENTRIES) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      problems.push(`${name} is not a plain file`);
      continue;
    }
    if (stat.uid !== expectedUid) problems.push(`${name} is not owned by root`);
    if ((modeOf(stat) & 0o077) !== 0) problems.push(`${name} is accessible to group or others`);
    if (stat.nlink !== 1) problems.push(`${name} has more than one hard link`);
    if (stat.size === 0) problems.push(`${name} is empty`);
    if (problems.length === 0 || stat.isFile()) contents[name] = fs.readFileSync(file);
  }
  if (problems.length || !contents[MANIFEST_FILE]) return result;

  const manifest = parseManifest(contents[MANIFEST_FILE].toString("utf8"));
  problems.push(...manifest.problems);
  for (const name of PAYLOAD_FILES) {
    const actual = sha256Hex(contents[name]);
    result.hashes[name] = actual;
    if (manifest.hashes.get(name) !== actual) problems.push(`${name} does not match its MANIFEST hash`);
  }
  for (const name of PROGRAM_FILES) {
    for (const rule of scanProgramText(contents[name].toString("utf8"))) {
      problems.push(`${name} contains a ${rule}`);
    }
  }
  try {
    const bundle = JSON.parse(contents[DATA_FILE].toString("utf8"));
    if (bundle === null || typeof bundle !== "object") problems.push("bundle.json is not a JSON object or array");
  } catch {
    problems.push("bundle.json is not valid JSON");
  }
  result.bundleSha256 = result.hashes[DATA_FILE];
  result.manifestSha256 = sha256Hex(contents[MANIFEST_FILE]);
  return result;
}

// --- repository mode ---------------------------------------------------------------------------

const FORBIDDEN_BASENAMES = new Set([
  "import_sheets.mjs",
  "rollback_import.mjs",
  "rollback-manifest.json",
  "before-snapshot.json",
  "bundle.json",
]);
const FORBIDDEN_PATH_PARTS = [/(^|\/)review\/reimport(\/|$)/, /(^|\/)opt\/newme-import(\/|$)/, /(^|\/)newme-import\/current(\/|$)/];
const DATA_EXTENSIONS = /\.(?:json|csv|tsv|xlsx|xls|ndjson)$/i;
// Column headers that only the sheet export has; a tracked data file carrying them is a leak.
const DATA_MARKERS = [/\bMaster Lead ID\b/, /"Lead key"/, /\bIntake channel\b[\s\S]{0,400}\bAssigned date\b/];

export function trackedFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

/** Judge a list of tracked paths with an optional reader for file text. */
export function judgeRepositoryFiles(files, readText = () => "") {
  const problems = [];
  for (const file of files) {
    const base = path.posix.basename(file);
    if (FORBIDDEN_BASENAMES.has(base)) problems.push(`${file}: import program or data file is tracked`);
    else if (FORBIDDEN_PATH_PARTS.some((pattern) => pattern.test(file))) problems.push(`${file}: import directory content is tracked`);
    else if (DATA_EXTENSIONS.test(base)) {
      const text = readText(file);
      if (typeof text === "string" && DATA_MARKERS.some((pattern) => pattern.test(text))) problems.push(`${file}: looks like a spreadsheet data export`);
    }
  }
  return problems;
}

export function checkRepository(root) {
  const files = trackedFiles(root);
  const read = (file) => {
    try {
      const full = path.join(root, file);
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return "";
      return fs.readFileSync(full, "utf8");
    } catch {
      return "";
    }
  };
  return judgeRepositoryFiles(files, read);
}

// --- command line ------------------------------------------------------------------------------

function main(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--import-dir", "--repo-root"].includes(argv[i]) || !argv[i + 1] || flags.has(argv[i])) throw Error("invalid S20 check arguments");
    flags.set(argv[i], argv[i + 1]);
  }
  if (flags.size === 0) throw Error("give --import-dir and/or --repo-root");
  const summary = { s20_import_gate: "approved" };
  const problems = [];
  if (flags.has("--import-dir")) {
    const verdict = verifyImportDir(flags.get("--import-dir"), { expectedUid: 0 });
    problems.push(...verdict.problems);
    summary.bundle_sha256 = verdict.bundleSha256;
    summary.manifest_sha256 = verdict.manifestSha256;
  }
  if (flags.has("--repo-root")) problems.push(...checkRepository(flags.get("--repo-root")));
  if (problems.length) throw Error(problems.join("; "));
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { HEX64 };
