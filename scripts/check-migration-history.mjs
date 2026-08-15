#!/usr/bin/env node
/**
 * Migration history immutability and forward-only gate.
 * ============================================================================
 * A migration that has been applied to production is a historical record. Once
 * it has run, editing it, renaming it or deleting it changes what the file says
 * happened without changing what happened — and the next person to replay the
 * directory gets a different database than production. The previous round of
 * this branch did exactly that: it renamed 1780601210_workflow_stages.sql to a
 * backdated 20260604192650_ name and rewrote 20260603000000_add_crm_fields.sql,
 * both of which production records as already applied. This gate exists so that
 * cannot happen again without the gate going red.
 *
 * It enforces four things against supabase/migration-history-baseline.sha256:
 *
 *   1. Immutability. Every file the manifest lists must still be present, under
 *      the same name, with the same content hash. Modified, deleted and renamed
 *      are reported as distinct failures because they are distinct mistakes.
 *
 *   2. Forward-only. A file present but not in the manifest is new, and its
 *      14-digit timestamp must sort strictly after every applied timestamp. A
 *      new migration that sorts into the middle of applied history applies in a
 *      different order on a fresh database than it did on production.
 *
 *   3. Filename shape. A new file must match the Supabase CLI's rule exactly
 *      (^[0-9]{14}_.*\.sql$), or be a hand-run companion the CLI never runs:
 *      rollback_*.sql or recontract_*.sql. The one legacy exception, the 10-digit
 *      epoch file, is pinned by the manifest rather than allowed by a pattern, so
 *      it cannot be the precedent for a second one.
 *
 *   4. Manifest integrity. The manifest itself is cross-checked against its
 *      BASE_COMMIT with git: same file set, same hashes. Without this the gate
 *      would be circular — anyone editing an applied migration could edit the
 *      manifest to match. If git or the base commit is unavailable the check
 *      FAILS; it does not downgrade to a warning, because a gate that skips
 *      itself when the environment is inconvenient is how the last round of
 *      false-greens happened. Use --no-git only for a local spot check, never
 *      in CI.
 *
 * Hashes are sha256 over content with CRLF normalised to LF. git stores LF; a
 * Windows checkout with core.autocrlf=true materialises CRLF. Hashing the raw
 * bytes would make this gate platform-dependent.
 *
 *   node scripts/check-migration-history.mjs
 *   node scripts/check-migration-history.mjs --list-new   # new set, one per line
 *   node scripts/check-migration-history.mjs --no-git     # local spot check only
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const MANIFEST = path.join(ROOT, "supabase", "migration-history-baseline.sha256");

const APPLIED_NAME = /^[0-9]{14}_.*\.sql$/;
// The two hand-run companion shapes. Neither matches APPLIED_NAME, which is the
// whole point: the Supabase CLI never applies them, so an operator runs them
// deliberately. `rollback_` gives up a posture; `recontract_` re-enters it after
// a rollback, because the migration that established it is already recorded and
// nothing pending would run again (review round 4 B9).
const COMPANION_NAME = /^(rollback|recontract)_.*\.sql$/;

const argv = new Set(process.argv.slice(2));
const LIST_NEW = argv.has("--list-new");
const NO_GIT = argv.has("--no-git");

const failures = [];
const fail = (message) => failures.push(message);

function normalisedHash(buffer) {
  // CRLF -> LF only. A bare CR inside a string literal is real content and is
  // left alone, so this cannot mask a change git would have tracked.
  const text = buffer.toString("utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- the manifest ----------------------------------------------------------
if (!fs.existsSync(MANIFEST)) {
  console.error(`missing manifest: ${path.relative(ROOT, MANIFEST)}`);
  process.exit(1);
}
const manifestText = fs.readFileSync(MANIFEST, "utf8");
const baseCommitMatch = manifestText.match(/^#\s*BASE_COMMIT\s+([0-9a-f]{40})\s*$/m);
const expected = new Map();
for (const rawLine of manifestText.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("#")) continue;
  const m = line.match(/^([0-9a-f]{64})\s\s(.+)$/);
  if (!m) {
    fail(`manifest line is not "<sha256>  <filename>": ${line}`);
    continue;
  }
  if (expected.has(m[2])) fail(`manifest lists ${m[2]} twice`);
  expected.set(m[2], m[1]);
}
if (expected.size === 0) fail("manifest lists no migrations");

// --- what is on disk -------------------------------------------------------
const onDisk = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".sql"))
  .map((e) => e.name)
  .sort();

const diskSet = new Set(onDisk);
const newFiles = [];
const companionFiles = [];

for (const name of onDisk) {
  if (expected.has(name)) continue;
  if (COMPANION_NAME.test(name)) {
    companionFiles.push(name);
  } else {
    newFiles.push(name);
  }
}

// 1 · immutability
let unchanged = 0;
for (const [name, hash] of expected) {
  const file = path.join(MIGRATIONS_DIR, name);
  if (!fs.existsSync(file)) {
    // Deleted or renamed. Distinguish them: a rename leaves an unlisted file
    // with identical content, which is by far the more likely mistake and much
    // easier to fix when the gate says so outright.
    const twin = newFiles.find(
      (candidate) => normalisedHash(fs.readFileSync(path.join(MIGRATIONS_DIR, candidate))) === hash,
    );
    if (twin) {
      fail(
        `applied migration ${name} was RENAMED to ${twin}. Production records it under the original name; ` +
          `restore the name and add any change as a new forward-only migration.`,
      );
    } else {
      fail(`applied migration ${name} was DELETED. Restore it byte-for-byte from ${baseCommitMatch?.[1] ?? "the PR base"}.`);
    }
    continue;
  }
  const actual = normalisedHash(fs.readFileSync(file));
  if (actual !== hash) {
    fail(
      `applied migration ${name} was MODIFIED (expected ${hash.slice(0, 12)}…, found ${actual.slice(0, 12)}…). ` +
        `It has already run on production; put the change in a new forward-only migration instead.`,
    );
    continue;
  }
  unchanged += 1;
}

// 2 + 3 · shape and forward-only
const appliedStamps = [...expected.keys()]
  .filter((name) => APPLIED_NAME.test(name))
  .map((name) => name.slice(0, 14));
const highestApplied = appliedStamps.sort().at(-1) ?? "";

const seenStamps = new Map();
for (const name of [...expected.keys()].filter((n) => APPLIED_NAME.test(n))) {
  seenStamps.set(name.slice(0, 14), name);
}

for (const name of newFiles) {
  if (!APPLIED_NAME.test(name)) {
    fail(
      `new migration ${name} does not match ^[0-9]{14}_.*\\.sql$, so the Supabase CLI will never apply it. ` +
        `The one legacy exception is pinned in the manifest and is not a precedent.`,
    );
    continue;
  }
  const stamp = name.slice(0, 14);
  if (stamp <= highestApplied) {
    fail(
      `new migration ${name} sorts at or before the last applied migration (${highestApplied}). ` +
        `New migrations must sort strictly after applied history, or a fresh database applies them in a ` +
        `different order than production did.`,
    );
  }
  const clash = seenStamps.get(stamp);
  if (clash && clash !== name) {
    fail(`new migration ${name} reuses the timestamp of ${clash}; apply order would be ambiguous`);
  }
  seenStamps.set(stamp, name);
}

for (const name of companionFiles) {
  if (!COMPANION_NAME.test(name)) fail(`unexpected companion filename: ${name}`);
}

// 4 · manifest integrity against the base commit
let gitChecked = false;
if (!NO_GIT) {
  const baseCommit = baseCommitMatch?.[1];
  if (!baseCommit) {
    fail("manifest has no '# BASE_COMMIT <40-hex>' header, so it cannot be cross-checked against git");
  } else {
    const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    try {
      git(["rev-parse", "--verify", `${baseCommit}^{commit}`]);
    } catch {
      fail(
        `base commit ${baseCommit} is not present in this clone, so the manifest cannot be verified. ` +
          `CI must check out with fetch-depth: 0.`,
      );
    }
    if (!failures.some((f) => f.includes("not present in this clone"))) {
      const listed = git(["ls-tree", "-r", "--name-only", baseCommit, "--", "supabase/migrations"])
        .toString("utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.endsWith(".sql"))
        .map((l) => l.replace(/^supabase\/migrations\//, ""))
        .filter((n) => !COMPANION_NAME.test(n))
        .sort();

      for (const name of listed) {
        if (!expected.has(name)) {
          fail(`${name} was applied as of the base commit but is missing from the manifest`);
          continue;
        }
        const atBase = normalisedHash(git(["show", `${baseCommit}:supabase/migrations/${name}`]));
        if (atBase !== expected.get(name)) {
          fail(`manifest hash for ${name} does not match its content at ${baseCommit.slice(0, 12)}`);
        }
      }
      const listedSet = new Set(listed);
      for (const name of expected.keys()) {
        if (!listedSet.has(name)) fail(`manifest lists ${name}, which does not exist at the base commit`);
      }
      gitChecked = true;
    }
  }
}

// --- report ----------------------------------------------------------------
if (LIST_NEW) {
  // Machine-readable, and only when the history itself is sound: handing a
  // caller the "new" set while applied files are modified would let a
  // downstream job act on a corrupted history.
  if (failures.length > 0) {
    console.error(`migration history check failed (${failures.length}); refusing to list the new set`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  for (const name of newFiles.sort()) console.log(name);
  process.exit(0);
}

console.log("migration history");
console.log(`  applied (immutable) : ${expected.size} listed, ${unchanged} verified unchanged`);
console.log(`  new on this branch  : ${newFiles.length}${newFiles.length ? ` (${newFiles.join(", ")})` : ""}`);
console.log(`  hand-run companions : ${companionFiles.length}${companionFiles.length ? ` (${companionFiles.join(", ")})` : ""}`);
console.log(`  last applied stamp  : ${highestApplied}`);
console.log(`  manifest vs git     : ${gitChecked ? `verified against ${baseCommitMatch?.[1].slice(0, 12)}` : "NOT VERIFIED"}`);
console.log(`  files on disk       : ${diskSet.size} .sql`);

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} problem${failures.length === 1 ? "" : "s"}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
if (!gitChecked && !NO_GIT) {
  console.error("\nFAIL — the manifest was not cross-checked against git");
  process.exit(1);
}
if (!gitChecked) {
  console.error("\nWARNING: --no-git was passed, so the manifest itself was not verified. Not valid as CI evidence.");
}
console.log("\nOK");
