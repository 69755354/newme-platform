#!/usr/bin/env node
/**
 * Release manifest gate — the phase split is the directory, exactly.
 * ============================================================================
 * infra/release/release-manifest.json names every migration this release adds
 * and puts each one in exactly one phase: `required_for_app` (the expand phase,
 * which must be applied before the candidate release is deployed) or
 * `deferred_contract` (applied only after the candidate is live and verified).
 * scripts/db-phase-push.mjs applies one phase and refuses anything the manifest
 * does not name, with the file's hash checked first.
 *
 * That only means something if the manifest cannot drift from the tree. Round-4
 * review C6 — "`applied_verified` does not prove all required migrations are
 * applied … claimed, remote and pending sets must exactly equal that manifest" —
 * and C7 — "provide and test an exact-hash phase tool" — both rest on this file
 * being true, so this gate checks:
 *
 *   1. Union. required_for_app ∪ deferred_contract is EXACTLY the set of
 *      CLI-applicable migrations that sort after `production_stamp`, in order. A
 *      migration added and not classified fails here, which is the failure mode
 *      that would otherwise leave a required migration out of the expand push.
 *   2. Disjointness, and one phase per file.
 *   3. Content. Every listed file exists and its sha256 (CRLF normalised to LF,
 *      the same text db-phase-push.mjs sends to the server) matches. Editing a
 *      migration without restamping fails.
 *   4. Ordering. Every deferred_contract version sorts strictly after every
 *      required_for_app version, so the expand phase is also a contiguous prefix
 *      of the pending set: an operator who reaches for `supabase db push` cannot
 *      apply the contract phase early by accident, and the applied order equals
 *      the version order the replay harness tests.
 *   5. Provenance. `base_commit` and `production_stamp` agree with
 *      supabase/migration-history-baseline.sha256 — the same base commit, and a
 *      stamp equal to its newest applied version. The stamp cannot be invented
 *      to reclassify an applied migration as pending.
 *   6. Posture. Each phase declares at least one runtime predicate; every
 *      predicate is a single read-only `select` with a unique name. The phase
 *      tool runs them in a READ ONLY transaction after applying, so a phase that
 *      "applied" without producing the posture it claims is a failure.
 *
 * It deliberately does NOT check that anything was applied: this gate runs in CI
 * against a checkout, where that question has no answer.
 *
 *   node scripts/check-release-manifest.mjs
 *   node scripts/check-release-manifest.mjs --stamp    # rewrite the hashes
 *   node scripts/check-release-manifest.mjs --phase required_for_app --list
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = path.join(ROOT, "infra", "release", "release-manifest.json");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const BASELINE = path.join(ROOT, "supabase", "migration-history-baseline.sha256");

export const PHASES = ["required_for_app", "deferred_contract"];
const CLI_MIGRATION = /^([0-9]{14})_(.+)\.sql$/;

/**
 * sha256 over content with CRLF normalised to LF, identical to
 * scripts/check-migration-history.mjs and to what db-phase-push.mjs hashes and
 * executes. Hashing raw bytes would make every gate here depend on whether the
 * checkout is a Windows one.
 */
export function contentHash(text) {
  return createHash("sha256").update(String(text).replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** The file's content as the phase tool would send it: CRLF normalised. */
export function readMigration(dir, file) {
  return fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
}

export function readManifest(file = MANIFEST_PATH) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("the release manifest is a symlink");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the release manifest must contain a JSON object");
  }
  return parsed;
}

/** Every entry of one phase, or of both phases in version order. */
export function manifestEntries(manifest, phase = null) {
  const phases = phase ? [phase] : PHASES;
  const entries = [];
  for (const name of phases) {
    const list = manifest[name];
    if (!Array.isArray(list)) throw new Error(`the release manifest has no ${name} array`);
    for (const entry of list) entries.push({ ...entry, phase: name });
  }
  return entries;
}

/**
 * The whole judgement as a pure function, so the gate is testable without a
 * checkout-shaped fixture. Returns a list of problems; empty means OK.
 */
export function auditManifest({ manifest, files, hashes, baseline }) {
  const problems = [];
  const fail = (message) => problems.push(message);

  const stamp = String(manifest.production_stamp ?? "");
  if (!/^[0-9]{14}$/.test(stamp)) {
    fail("production_stamp must be a 14-digit migration version");
    return problems;
  }
  if (manifest.hash_algorithm !== "sha256-crlf-normalised") {
    fail(`hash_algorithm must be "sha256-crlf-normalised", not ${JSON.stringify(manifest.hash_algorithm ?? null)}`);
  }

  // 5 · provenance
  if (baseline) {
    if (baseline.baseCommit && manifest.base_commit !== baseline.baseCommit) {
      fail(
        `base_commit ${JSON.stringify(String(manifest.base_commit ?? ""))} is not the migration-history baseline's BASE_COMMIT ${baseline.baseCommit}`,
      );
    }
    if (baseline.newestApplied && stamp !== baseline.newestApplied) {
      fail(
        `production_stamp ${stamp} is not the newest version in the migration-history baseline (${baseline.newestApplied}): the pending set would be computed from an invented boundary`,
      );
    }
  }

  let entries;
  try {
    entries = manifestEntries(manifest);
  } catch (error) {
    fail(error.message);
    return problems;
  }

  // 2 · one phase per file, and well-formed entries
  const seen = new Map();
  for (const entry of entries) {
    const file = String(entry.file ?? "");
    const match = CLI_MIGRATION.exec(file);
    if (!match) {
      fail(`${entry.phase}: ${JSON.stringify(file)} is not a CLI-applicable migration filename`);
      continue;
    }
    if (String(entry.version ?? "") !== match[1]) {
      fail(`${file} is listed under version ${JSON.stringify(String(entry.version ?? ""))}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256 ?? ""))) {
      fail(`${file} has no sha256`);
    }
    if (seen.has(file)) {
      fail(`${file} is listed in both ${seen.get(file)} and ${entry.phase}`);
      continue;
    }
    seen.set(file, entry.phase);
  }

  // 1 · union == pending set, in order
  const pending = files.filter((file) => CLI_MIGRATION.test(file) && file.slice(0, 14) > stamp).sort();
  const listed = [...seen.keys()].sort();
  for (const file of pending) {
    if (!seen.has(file)) {
      fail(
        `${file} sorts after ${stamp} but no phase claims it: classify it as required_for_app or deferred_contract`,
      );
    }
  }
  for (const file of listed) {
    if (!pending.includes(file)) {
      fail(`${file} is listed in ${seen.get(file)} but is not a pending migration in supabase/migrations/`);
    }
  }
  for (const name of PHASES) {
    const ordered = manifest[name].map((entry) => String(entry.file ?? ""));
    if (JSON.stringify(ordered) !== JSON.stringify([...ordered].sort())) {
      fail(`${name} is not listed in version order`);
    }
  }
  if (!Array.isArray(manifest.deferred_contract) || manifest.deferred_contract.length === 0) {
    fail("deferred_contract must name the contract-phase migration");
  }

  // 3 · content
  for (const entry of entries) {
    const file = String(entry.file ?? "");
    if (!pending.includes(file)) continue; // already reported
    const actual = hashes.get(file);
    if (actual === undefined) {
      fail(`${file} is listed in the manifest but is not present in supabase/migrations/`);
    } else if (actual !== entry.sha256) {
      fail(
        `${file} has changed since the manifest was stamped (manifest ${String(entry.sha256).slice(0, 12)}…, file ${actual.slice(0, 12)}…): rerun with --stamp and have the change reviewed`,
      );
    }
  }

  // 4 · ordering: the contract phase is the tail
  const requiredVersions = (manifest.required_for_app ?? []).map((entry) => String(entry.version ?? ""));
  const deferredVersions = (manifest.deferred_contract ?? []).map((entry) => String(entry.version ?? ""));
  const newestRequired = [...requiredVersions].sort().at(-1);
  for (const version of deferredVersions) {
    if (newestRequired !== undefined && version <= newestRequired) {
      fail(
        `deferred_contract ${version} does not sort after every required_for_app version (newest is ${newestRequired}): the expand phase would not be a prefix of the pending set, and \`supabase db push\` could not produce it without applying the contract phase early`,
      );
    }
  }

  // 6 · posture
  const posture = manifest.posture ?? {};
  const names = new Set();
  for (const phase of PHASES) {
    const declared = posture[phase];
    const predicates = Array.isArray(declared?.predicates) ? declared.predicates : null;
    if (!predicates || predicates.length === 0) {
      fail(`posture.${phase}.predicates must declare at least one runtime check for the phase`);
      continue;
    }
    for (const predicate of predicates) {
      const name = String(predicate?.name ?? "");
      if (name === "") fail(`posture.${phase} has an unnamed predicate`);
      if (names.has(name)) fail(`posture predicate ${JSON.stringify(name)} is declared twice`);
      names.add(name);
      if (typeof predicate?.expect !== "boolean") {
        fail(`posture predicate ${JSON.stringify(name)} must declare a boolean expect`);
      }
      const sql = String(predicate?.sql ?? "").trim();
      const readOnly = /^select\b/i.test(sql) && !sql.includes(";");
      const forbidden = /\b(insert|update|delete|alter|drop|grant|revoke|truncate|create|call|do|copy|set)\b/i.test(sql);
      if (!readOnly || forbidden) {
        fail(
          `posture predicate ${JSON.stringify(name)} must be a single read-only select: the phase tool runs it against production`,
        );
      }
    }
  }

  return problems;
}

/** BASE_COMMIT and the newest applied version, read from the history baseline. */
export function readBaseline(file = BASELINE) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const baseCommit = text.match(/^#\s*BASE_COMMIT\s+([0-9a-f]{40})\s*$/m)?.[1] ?? null;
  const versions = [...text.matchAll(/^[0-9a-f]{64}\s+([0-9]{14})_.*\.sql\s*$/gm)].map((match) => match[1]).sort();
  return { baseCommit, newestApplied: versions.at(-1) ?? null };
}

function stamp() {
  const manifest = readManifest();
  const text = fs.readFileSync(MANIFEST_PATH, "utf8");
  let updated = text;
  let changed = 0;
  for (const entry of manifestEntries(manifest)) {
    const file = String(entry.file);
    if (!fs.existsSync(path.join(MIGRATIONS_DIR, file))) continue;
    const hash = contentHash(readMigration(MIGRATIONS_DIR, file));
    if (hash === entry.sha256) continue;
    // Replace only the sha256 that follows this filename, so --stamp can never
    // reclassify a file or add one: the union check is not something a stamp may
    // silence.
    const pattern = new RegExp(
      `("file"\\s*:\\s*"${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*,\\s*"sha256"\\s*:\\s*")[0-9a-f]{64}(")`,
    );
    if (!pattern.test(updated)) {
      console.error(`--stamp could not find the sha256 for ${file}; fix the manifest by hand`);
      return 1;
    }
    updated = updated.replace(pattern, `$1${hash}$2`);
    changed += 1;
    console.log(`restamped ${file}`);
  }
  if (changed === 0) {
    console.log("release manifest: hashes already match");
    return 0;
  }
  fs.writeFileSync(MANIFEST_PATH, updated);
  console.log(`release manifest: restamped ${changed} file(s)`);
  return 0;
}

function main(argv) {
  const args = new Set(argv);
  if (args.has("--stamp")) return stamp();

  const manifest = readManifest();
  if (args.has("--list")) {
    const index = argv.indexOf("--phase");
    const phase = index >= 0 ? argv[index + 1] : null;
    if (phase && !PHASES.includes(phase)) {
      console.error(`unknown phase ${JSON.stringify(phase)}`);
      return 1;
    }
    for (const entry of manifestEntries(manifest, phase)) console.log(entry.file);
    return 0;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => CLI_MIGRATION.test(file)).sort();
  const hashes = new Map(files.map((file) => [file, contentHash(readMigration(MIGRATIONS_DIR, file))]));
  const problems = auditManifest({ manifest, files, hashes, baseline: readBaseline() });

  console.log(`release             : ${manifest.release}`);
  console.log(`base commit         : ${manifest.base_commit}`);
  console.log(`production stamp    : ${manifest.production_stamp}`);
  console.log(`required_for_app    : ${(manifest.required_for_app ?? []).length}`);
  console.log(`deferred_contract   : ${(manifest.deferred_contract ?? []).length}`);
  console.log(`pending in tree     : ${files.filter((file) => file.slice(0, 14) > manifest.production_stamp).length}`);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`release manifest: ${problem}`);
    console.error(`refusing: ${problems.length} problem(s)`);
    return 1;
  }
  console.log("OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`release manifest: ${error.message}`);
    process.exit(1);
  }
}
