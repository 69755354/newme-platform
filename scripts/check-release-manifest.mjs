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
 *   7. Phase coupling. `runs_under.database_phases` names the direct-write modes
 *      this release can serve traffic under, and scripts/check-release-phase.mjs
 *      reads it before any path switches the `current` symlink (Round-4 C8). The
 *      declaration is validated by that module's own resolver, so the deploy path
 *      and this gate cannot disagree about what a declaration means, and it must
 *      be present: a release that ships the mode may not fall back to the
 *      pre-mechanism default, which exists for releases that predate the key.
 *
 *   8. Companions (Round-4 C4-5). `companions` names every hand-run
 *      rollback_*.sql / recontract_*.sql file in supabase/migrations/, with the
 *      same content hash, and the set must be EXACTLY the set on disk. These
 *      files are the ones an operator executes against production by hand, and
 *      before this rule nothing in the release recorded what they contained:
 *      they are deliberately excluded from the applied-history manifest (they are
 *      not history), they never reach supabase_migrations.schema_migrations, so
 *      the remote-history fingerprint gate structurally cannot cover them, and
 *      two of the five were executed by no gate at all. Measured on PG 17.10: a
 *      `grant execute on function public.create_contract(jsonb) to authenticated`
 *      appended to rollback_money_direct_write_contract_phase.sql — the exact
 *      authorization defect this release exists to close — left `MODE=branch`
 *      green, and the same line inside rollback_p0_10.sql was not executed at all.
 *      Set equality is checked in both directions, because a companion added and
 *      not declared is the whole failure mode.
 *
 * It deliberately does NOT check that anything was applied: this gate runs in CI
 * against a checkout, where that question has no answer.
 *
 * `--verify-claim` is the one mode that is about a deploy rather than about the
 * tree, and it still answers a question with no database in it: is the migration
 * claim on the deploy command line the set this manifest requires? See
 * auditReleaseClaim() for why the deploy may not be trusted to name it.
 *
 *   node scripts/check-release-manifest.mjs
 *   node scripts/check-release-manifest.mjs --stamp    # rewrite the hashes
 *   node scripts/check-release-manifest.mjs --phase required_for_app --list
 *   node scripts/check-release-manifest.mjs --verify-companions
 *   node scripts/check-release-manifest.mjs --verify-claim \
 *     --status applied_verified --ids 20260806000000,...
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Rule 7 is judged by the resolver the deploy path uses, not by a second reading
// of the same key: the whole point of the declaration is that the manifest gate
// and scripts/check-release-phase.mjs agree about what it means.
import { COMPLETION_PHASE, resolveDeclaredPhases } from "./check-release-phase.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = path.join(ROOT, "infra", "release", "release-manifest.json");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const BASELINE = path.join(ROOT, "supabase", "migration-history-baseline.sha256");

export const PHASES = ["required_for_app", "deferred_contract"];
const CLI_MIGRATION = /^([0-9]{14})_(.+)\.sql$/;
/**
 * The hand-run companion shapes, identical to the pattern in
 * scripts/check-migration-history.mjs. That script is a top-level program with no
 * exports, so this is a second literal rather than an import, and
 * tests/release/companion-binding.test.mjs holds the two source lines equal — the
 * one copy that is allowed, and it is pinned.
 */
export const COMPANION_NAME = /^(rollback|recontract)_.*\.sql$/;

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

/**
 * Every .sql file in a migrations directory and its normalised hash — numbered
 * migrations and hand-run companions alike.
 *
 * One reader, three callers (this gate, scripts/db-phase-push.mjs and the tests),
 * because a caller that filtered companions out of `files` would silently turn
 * rule 8's set equality into "the manifest lists companions that are not on
 * disk". Round-4 C4-2 was four copies of one list disagreeing; this is the same
 * shape and it gets one implementation.
 */
export function readTreeFiles(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
  return { files, hashes: new Map(files.map((file) => [file, contentHash(readMigration(dir, file))])) };
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
 * Rule 8 on its own, so the full gate and `--verify-companions` cannot disagree
 * about what a declared companion set means. `--verify-companions` is what the
 * canonical deploy path runs against the candidate worktree, where the history
 * baseline and the pending set are not the question being asked.
 *
 * Returns a list of problems; empty means the declared set is exactly the set on
 * disk and every byte matches.
 */
export function auditCompanions({ manifest, files, hashes }) {
  const problems = [];
  const fail = (message) => problems.push(message);

  const onDisk = files.filter((file) => COMPANION_NAME.test(file)).sort();
  const declared = manifest.companions;
  if (!Array.isArray(declared)) {
    fail(
      "companions must be an array naming every hand-run rollback_*.sql / recontract_*.sql file in supabase/migrations/: an operator executes those against production and nothing else in this release records what they contain",
    );
    return problems;
  }

  const seen = new Map();
  for (const entry of declared) {
    const file = String(entry?.file ?? "");
    if (!COMPANION_NAME.test(file)) {
      fail(`companions: ${JSON.stringify(file)} is not a hand-run companion filename (rollback_*.sql or recontract_*.sql)`);
      continue;
    }
    // The kind is not decoration: scripts/replay-migrations.sh decides what to
    // execute from the filename prefix, so a mislabelled entry is a claim about
    // execution order that the harness will not honour.
    const prefix = file.slice(0, file.indexOf("_"));
    if (String(entry?.kind ?? "") !== prefix) {
      fail(`companions: ${file} is declared kind ${JSON.stringify(String(entry?.kind ?? ""))}, but its filename says ${JSON.stringify(prefix)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(entry?.sha256 ?? ""))) fail(`companions: ${file} has no sha256`);
    if (seen.has(file)) {
      fail(`companions: ${file} is listed twice`);
      continue;
    }
    seen.set(file, String(entry?.sha256 ?? ""));
  }

  const order = declared.map((entry) => String(entry?.file ?? ""));
  if (JSON.stringify(order) !== JSON.stringify([...order].sort())) {
    fail("companions is not listed in filename order");
  }

  // Set equality, both directions. A companion added and left undeclared is the
  // failure mode this rule exists for; a declared file that is gone is a rollback
  // path the release claims to have and does not.
  for (const file of onDisk) {
    if (!seen.has(file)) {
      fail(
        `${file} is a hand-run companion in supabase/migrations/ but the manifest does not name it: an operator can execute it against production and no gate in this release would know what it contained`,
      );
    }
  }
  for (const file of seen.keys()) {
    if (!onDisk.includes(file)) {
      fail(`companions lists ${file}, which is not present in supabase/migrations/`);
    }
  }
  for (const [file, sha] of seen) {
    const actual = hashes.get(file);
    if (actual === undefined) continue; // already reported as absent
    if (actual !== sha) {
      fail(
        `${file} has changed since the manifest was stamped (manifest ${sha.slice(0, 12)}…, file ${actual.slice(0, 12)}…): rerun with --stamp and have the change reviewed`,
      );
    }
  }
  if (problems.length === 0 && onDisk.length === 0) {
    fail("companions is declared but supabase/migrations/ holds no hand-run companion: one side of this release's rollback path is missing");
  }
  return problems;
}

/** A migration id as an operator may type it, reduced to its version. */
export function normalizeClaimId(id) {
  const text = String(id ?? "").trim().replace(/\.sql$/i, "");
  const match = /^([0-9]{14})(?:_.*)?$/.exec(text);
  return match ? match[1] : null;
}

/**
 * The deploy's migration claim, judged against the manifest — round-4 C4-1.
 * ============================================================================
 * `newme-deploy <sha> <run-id> applied_verified <ids>` took `<ids>` from the
 * operator and passed it verbatim to scripts/verify-remote-migration-history.mjs
 * as `--require-applied`. That gate re-measures every id it is given, which reads
 * like proof and is not: the claim is also the *scope*. Measured against this
 * release's own manifest, with the history gate's own pure judgement:
 *
 *   * `applied_verified 20260806000000` — one id of the seventeen this release
 *     requires — produced ZERO findings with sixteen required migrations
 *     unapplied. The app would have been switched onto a schema that is missing
 *     the authorization migrations it exists to ship.
 *   * the same gate produced ZERO findings for a history that had ALSO applied the
 *     deferred contract phase before the switch, which closes the previous
 *     release's direct-write path while the previous release is still live — the
 *     outage supabase/preflight/expand-contract-rollback.md §2 exists to prevent.
 *
 * Neither is a claim an honest operator would make on purpose; both are what a
 * copied command line, a partial `supabase db push`, or a resumed session
 * produces. So the required set is derived here, from the manifest in the tree
 * being deployed, and the operator's list is compared against it for EXACT set
 * equality — a subset is refused, and so is a superset, because the only id this
 * release adds beyond the required set is the one that must not be applied yet.
 *
 * Returns { problems, required, deferred } with both sets as sorted versions.
 * `required` and `deferred` are what the caller passes to the history gate, so
 * they are derived only from entries this function has validated: a malformed
 * manifest yields problems AND empty sets, never a partial set that would silence
 * the very check it feeds.
 */
export function auditReleaseClaim({ manifest, status, claimed = [] }) {
  const problems = [];
  const fail = (message) => problems.push(message);

  const versions = (phase) => {
    const list = manifest?.[phase];
    if (!Array.isArray(list)) {
      fail(`${phase} must be an array: the required migration set cannot be derived from this manifest`);
      return null;
    }
    const out = [];
    for (const entry of list) {
      const file = String(entry?.file ?? "");
      const match = CLI_MIGRATION.exec(file);
      if (!match) {
        fail(`${phase} entry ${JSON.stringify(file)} is not a CLI-applicable migration filename`);
        return null;
      }
      if (String(entry?.version ?? "") !== match[1]) {
        fail(`${phase} lists ${file} under version ${JSON.stringify(String(entry?.version ?? ""))}`);
        return null;
      }
      if (!/^[0-9a-f]{64}$/.test(String(entry?.sha256 ?? ""))) {
        fail(`${phase} lists ${file} with no sha256, so the deploy cannot be told to require it`);
        return null;
      }
      out.push(match[1]);
    }
    return out.sort();
  };

  const required = versions("required_for_app");
  const deferred = versions("deferred_contract");
  if (required === null || deferred === null) return { problems, required: [], deferred: [] };
  for (const version of deferred) {
    if (required.includes(version)) {
      fail(`${version} is listed in both required_for_app and deferred_contract`);
      return { problems, required: [], deferred: [] };
    }
  }

  const ids = (Array.isArray(claimed) ? claimed : String(claimed).split(","))
    .map((id) => String(id).trim())
    .filter((id) => id !== "");
  const claimedVersions = new Set();
  for (const id of ids) {
    const version = normalizeClaimId(id);
    if (version === null) {
      fail(`${JSON.stringify(id)} is not a migration id: expected a 14-digit version or a migration filename`);
      continue;
    }
    if (claimedVersions.has(version)) fail(`the claim names ${version} twice`);
    claimedVersions.add(version);
  }

  if (status === "applied_verified") {
    for (const version of claimedVersions) {
      if (required.includes(version)) continue;
      fail(
        deferred.includes(version)
          ? `the claim names ${version}, which is this release's deferred contract-phase migration: it closes the previous release's direct money-write path and must not be applied until the candidate is live and verified (runbook §4). Roll the phase back before deploying.`
          : `the claim names ${version}, which this release's manifest does not list as required before the app switch`,
      );
    }
    const missing = required.filter((version) => !claimedVersions.has(version));
    if (missing.length > 0) {
      fail(
        `the claim names ${claimedVersions.size} migration(s) but this release requires all ${required.length} of required_for_app before the app may be switched; missing ${missing.join(", ")}. A proper subset is not a claim that this release's schema is present.`,
      );
    }
    if (required.length === 0) {
      fail("applied_verified was claimed but this release's manifest requires no migrations before the switch; use not_required");
    }
  } else if (status === "not_required") {
    if (claimedVersions.size > 0) fail("not_required must not carry migration ids");
    if (required.length > 0) {
      fail(
        `not_required was claimed but this release's manifest requires ${required.length} migration(s) before the app switch (${required.join(", ")})`,
      );
    }
  } else {
    fail(`the migration status must be applied_verified or not_required, not ${JSON.stringify(String(status ?? ""))}`);
  }

  return { problems, required, deferred };
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
      // Named separately from "not a CLI-applicable filename": a companion in a
      // phase array would be applied AND recorded in
      // supabase_migrations.schema_migrations by the phase tool, which is how a
      // hand-run rollback becomes a permanent part of the history it undoes.
      fail(
        COMPANION_NAME.test(file)
          ? `${entry.phase} lists the hand-run companion ${file}; companions are declared under "companions" and are never applied by the CLI or the phase tool`
          : `${entry.phase}: ${JSON.stringify(file)} is not a CLI-applicable migration filename`,
      );
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
      // The keyword scan reads the STATEMENT, not the contents of its string
      // literals. A predicate that inspects SQL text — pg_get_functiondef()
      // against a pattern, which is how the mode-controlled guards and the KPI
      // writers are derived from bodies rather than from a list of names —
      // legitimately carries the words `update`, `insert` and `delete` inside a
      // quoted pattern, and scanning those made the only fail-closed form of
      // that check impossible to declare. Removing literals cannot let a
      // mutation through: a single statement that starts with `select` and
      // contains no semicolon cannot execute what is inside a string constant.
      // An unbalanced quote is its own refusal, so the removal is never applied
      // to a statement it could mis-parse, and $$-quoting is not unwrapped at
      // all — a keyword inside one still fails closed.
      const collapsed = sql.replace(/''/g, "");
      const balanced = (collapsed.match(/'/g) ?? []).length % 2 === 0;
      const bare = collapsed.replace(/'[^']*'/g, "''");
      const forbidden = /\b(insert|update|delete|alter|drop|grant|revoke|truncate|create|call|do|copy|set)\b/i.test(bare);
      if (!readOnly || forbidden || !balanced) {
        fail(
          `posture predicate ${JSON.stringify(name)} must be a single read-only select: the phase tool runs it against production`,
        );
      }
    }
  }

  // 8 · companions
  for (const problem of auditCompanions({ manifest, files, hashes })) fail(problem);

  // 7 · phase coupling
  const declaration = resolveDeclaredPhases(manifest);
  for (const problem of declaration.problems) fail(problem);
  if (declaration.problems.length === 0) {
    if (declaration.source !== "declared") {
      fail(
        "runs_under.database_phases must name the direct-write modes this release can serve traffic under: scripts/check-release-phase.mjs refuses to switch to a release it cannot place, and the pre-mechanism default it would otherwise apply is for releases that predate the key, not for this one",
      );
    } else {
      // The mode function is created by an expand migration
      // (20260814000000_l0_round3_authorization_and_integrity.sql), so `absent`
      // means a required_for_app migration has not been applied — which is the one
      // state in which this release must not be serving traffic at all.
      if (declaration.phases.includes("absent") && (manifest.required_for_app ?? []).length > 0) {
        fail(
          "runs_under.database_phases claims this release runs under `absent`, but `absent` is the state before its own required_for_app migrations are applied",
        );
      }
      // Completion is only declared in strict, so a release that cannot run there
      // could never be finished; and between the expand push and the contract push
      // the candidate serves live traffic in compat, so it has to run there too.
      if (!declaration.phases.includes(COMPLETION_PHASE)) {
        fail(
          `runs_under.database_phases does not include ${JSON.stringify(COMPLETION_PHASE)}: the deferred contract phase moves the database there, so this release could never be completed`,
        );
      }
      if ((manifest.deferred_contract ?? []).length > 0 && !declaration.phases.includes("compat")) {
        fail(
          "runs_under.database_phases does not include \"compat\": this release defers a contract migration, so it serves live traffic in compat between the two pushes",
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

/**
 * Every entry `--stamp` may restamp: the two phase arrays and the companions.
 * A companion left out of this list would be declared once and then never
 * restamped, which reads as "unchanged since the release was cut" for as long as
 * nobody looks.
 */
function stampableEntries(manifest) {
  const companions = Array.isArray(manifest.companions) ? manifest.companions : [];
  return [...manifestEntries(manifest), ...companions.map((entry) => ({ ...entry, phase: "companions" }))];
}

function stamp() {
  const manifest = readManifest();
  const text = fs.readFileSync(MANIFEST_PATH, "utf8");
  let updated = text;
  let changed = 0;
  for (const entry of stampableEntries(manifest)) {
    const file = String(entry.file);
    if (!fs.existsSync(path.join(MIGRATIONS_DIR, file))) continue;
    const hash = contentHash(readMigration(MIGRATIONS_DIR, file));
    if (hash === entry.sha256) continue;
    // Replace only the sha256 that follows this filename, so --stamp can never
    // reclassify a file or add one: the union check is not something a stamp may
    // silence. A companion entry carries its `kind` between the two keys, and
    // that is the only thing allowed between them — anything else and the stamp
    // refuses rather than guessing which hash it is looking at.
    const pattern = new RegExp(
      `("file"\\s*:\\s*"${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*,\\s*(?:"kind"\\s*:\\s*"[a-z]+"\\s*,\\s*)?"sha256"\\s*:\\s*")[0-9a-f]{64}(")`,
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

/**
 * Rule 8 alone, against a named migrations directory. This is what the canonical
 * deploy path runs on the candidate worktree before it will install anything: the
 * script and the manifest both come out of the release being deployed, so what it
 * proves is "the companions at this SHA are the companions this SHA declares".
 * The full gate's other rules need the history baseline and the pending set, which
 * is CI's question, not the deploy path's.
 */
function verifyCompanions(argv) {
  const index = argv.indexOf("--migrations-dir");
  const dir = index >= 0 ? String(argv[index + 1] ?? "") : MIGRATIONS_DIR;
  if (dir === "") {
    console.error("--migrations-dir needs a directory");
    return 1;
  }
  const manifest = readManifest();
  const { files, hashes } = readTreeFiles(dir);
  const problems = auditCompanions({ manifest, files, hashes });
  const declared = Array.isArray(manifest.companions) ? manifest.companions : [];
  for (const entry of declared) {
    const file = String(entry?.file ?? "");
    const actual = hashes.get(file);
    console.log(`companion ${actual === String(entry?.sha256 ?? "") ? "OK " : "BAD"} ${String(entry?.kind ?? "?").padEnd(10)} ${file} ${String(actual ?? "absent").slice(0, 12)}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`release companions: ${problem}`);
    console.error(`refusing: ${problems.length} problem(s)`);
    return 1;
  }
  console.log(`release companions: ${declared.length} hand-run file(s) match the manifest`);
  return 0;
}

/**
 * The migration claim on the deploy command line, against the manifest in the tree
 * being deployed (round-4 C4-1). Two things have to be true before a derived set is
 * worth anything, and both are checked here:
 *
 *   1. the manifest describes this tree — the full audit, so a required migration
 *      present in supabase/migrations/ and missing from `required_for_app` cannot
 *      make the derived set a subset of the truth;
 *   2. the operator's list is exactly the derived `required_for_app` set.
 *
 * On success the derived sets are printed as two `key=value` lines for the caller to
 * pass on, and they are printed on failure too: the operator's next move is to run
 * the deploy with the set this names.
 */
function verifyClaim(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? String(argv[index + 1] ?? "") : "";
  };
  const status = value("--status");
  const ids = value("--ids");
  const dirArg = value("--migrations-dir");
  const dir = dirArg === "" ? MIGRATIONS_DIR : dirArg;
  if (status === "") {
    console.error("--verify-claim requires --status applied_verified|not_required");
    return 1;
  }

  const manifest = readManifest();
  const { files, hashes } = readTreeFiles(dir);
  const structural = auditManifest({ manifest, files, hashes, baseline: readBaseline() });
  const claim = auditReleaseClaim({ manifest, status, claimed: ids.split(",") });

  // Machine-readable first, and unconditionally: the caller reads these two lines,
  // and a reader of a failed deploy log needs the derived set in front of them.
  console.log(`required_for_app=${claim.required.join(",")}`);
  console.log(`deferred_contract=${claim.deferred.join(",")}`);

  if (structural.length > 0) {
    for (const problem of structural) console.error(`release claim: ${problem}`);
    console.error(
      `release claim: the manifest at this SHA does not describe supabase/migrations/, so the required set cannot be derived from it (${structural.length} problem(s))`,
    );
    return 1;
  }
  if (claim.problems.length > 0) {
    for (const problem of claim.problems) console.error(`release claim: ${problem}`);
    console.error(`refusing: ${claim.problems.length} problem(s)`);
    return 1;
  }
  console.log(
    `release claim: ${status} agrees with the manifest — ${claim.required.length} required before the switch, ${claim.deferred.length} deferred until after it`,
  );
  return 0;
}

function main(argv) {
  const args = new Set(argv);
  if (args.has("--stamp")) return stamp();
  if (args.has("--verify-companions")) return verifyCompanions(argv);
  if (args.has("--verify-claim")) return verifyClaim(argv);

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

  const { files, hashes } = readTreeFiles();
  const problems = auditManifest({ manifest, files, hashes, baseline: readBaseline() });

  console.log(`release             : ${manifest.release}`);
  console.log(`base commit         : ${manifest.base_commit}`);
  console.log(`production stamp    : ${manifest.production_stamp}`);
  console.log(`required_for_app    : ${(manifest.required_for_app ?? []).length}`);
  console.log(`deferred_contract   : ${(manifest.deferred_contract ?? []).length}`);
  // CLI_MIGRATION first: a companion filename beats any 14-digit stamp in a
  // string comparison (letters sort after digits), so counting `files` unfiltered
  // would report five phantom pending migrations.
  console.log(
    `pending in tree     : ${files.filter((file) => CLI_MIGRATION.test(file) && file.slice(0, 14) > manifest.production_stamp).length}`,
  );
  console.log(`hand-run companions : ${(manifest.companions ?? []).length}`);

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
