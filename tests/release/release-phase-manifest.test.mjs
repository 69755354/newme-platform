// ============================================================================
// Contract test: the release manifest and the two-phase applier
// ============================================================================
// Round-4 review C6 and C7:
//
//   C6 — "commit an exact release manifest with `required_for_app` and
//         `deferred_contract`; claimed, remote and pending sets must exactly equal
//         that manifest, plus runtime schema/function posture checks"
//   C7 — "provide and test an exact-hash phase tool that records correct migration
//         history. Do not temporarily remove files or rewrite history."
//
// The manifest is infra/release/release-manifest.json, the tool is
// scripts/db-phase-push.mjs, and the end-to-end test against a real database is
// scripts/phase-tool-drill.sh (CI job `migration-replay`). This file covers what
// can be decided without a database: that the committed manifest describes this
// tree, and that every refusal the tool depends on actually refuses. The
// judgements are pure functions for exactly that reason.
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  auditManifest,
  contentHash,
  manifestEntries,
  readBaseline,
  readManifest,
  readMigration,
} from "../../scripts/check-release-manifest.mjs";
import {
  isTransactionControl,
  nonTransactional,
  planPhase,
  splitStatements,
  statementsFingerprint,
} from "../../scripts/db-phase-push.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const CLI_MIGRATION = /^[0-9]{14}_.*\.sql$/;

const manifest = readManifest();
const files = readdirSync(MIGRATIONS_DIR).filter((file) => CLI_MIGRATION.test(file)).sort();
const hashes = new Map(files.map((file) => [file, contentHash(readMigration(MIGRATIONS_DIR, file))]));

/** A deep copy, so a test that breaks the manifest cannot affect another. */
const copy = () => JSON.parse(JSON.stringify(manifest));

test("the committed manifest describes this tree", () => {
  const problems = auditManifest({ manifest, files, hashes, baseline: readBaseline() });
  assert.deepEqual(problems, []);

  // The two phases together are the pending set, and the contract phase is one
  // file. Stated here as well as computed, because these are the two facts the
  // deployment procedure is written against.
  const pending = files.filter((file) => file.slice(0, 14) > manifest.production_stamp);
  assert.equal(manifest.required_for_app.length + manifest.deferred_contract.length, pending.length);
  assert.equal(manifest.deferred_contract.length, 1);
  assert.match(manifest.deferred_contract[0].file, /^20260818000000_money_direct_write_contract_phase\.sql$/);
});

test("a pending migration that no phase claims fails the gate", () => {
  // The failure this exists for: someone adds a migration, CI is green, and the
  // expand push silently does not contain it.
  const problems = auditManifest({
    manifest,
    files: [...files, "20260819000000_a_migration_nobody_classified.sql"],
    hashes: new Map([...hashes, ["20260819000000_a_migration_nobody_classified.sql", "0".repeat(64)]]),
    baseline: readBaseline(),
  });
  assert.ok(
    problems.some((problem) => /20260819000000.*no phase claims it/.test(problem)),
    problems.join("\n"),
  );
});

test("a file in both phases, and a file in no directory, both fail", () => {
  const both = copy();
  both.deferred_contract.push({ ...both.required_for_app[0] });
  assert.ok(
    auditManifest({ manifest: both, files, hashes, baseline: readBaseline() }).some((problem) =>
      /is listed in both required_for_app and deferred_contract/.test(problem),
    ),
  );

  const ghost = copy();
  ghost.required_for_app.push({
    version: "20260819000000",
    file: "20260819000000_not_in_the_tree.sql",
    sha256: "0".repeat(64),
  });
  assert.ok(
    auditManifest({ manifest: ghost, files, hashes, baseline: readBaseline() }).some((problem) =>
      /20260819000000_not_in_the_tree\.sql is listed in required_for_app but is not a pending migration/.test(problem),
    ),
  );
});

test("editing a migration without restamping fails the gate", () => {
  const drifted = new Map(hashes);
  const victim = manifest.required_for_app.at(-1).file;
  drifted.set(victim, "f".repeat(64));
  const problems = auditManifest({ manifest, files, hashes: drifted, baseline: readBaseline() });
  assert.ok(problems.some((problem) => problem.includes(`${victim} has changed since the manifest was stamped`)), problems.join("\n"));
});

test("the contract phase must sort after every expand migration", () => {
  const inverted = copy();
  // Renumber the contract phase to the middle of the expand set, as it was
  // before this round: 20260815000000, with round-4 files above it.
  inverted.deferred_contract = [
    { version: "20260815000000", file: "20260815000000_money_direct_write_contract_phase.sql", sha256: "a".repeat(64) },
  ];
  const filesWithOld = [...files.filter((file) => !file.startsWith("20260818000000")), inverted.deferred_contract[0].file].sort();
  const hashesWithOld = new Map([...hashes, [inverted.deferred_contract[0].file, "a".repeat(64)]]);
  const problems = auditManifest({
    manifest: inverted,
    files: filesWithOld,
    hashes: hashesWithOld,
    baseline: readBaseline(),
  });
  assert.ok(
    problems.some((problem) => /does not sort after every required_for_app version/.test(problem)),
    problems.join("\n"),
  );
});

test("a posture predicate that is not a read-only select fails the gate", () => {
  // The tool runs these against production. Anything but a single select is a
  // production mutation hidden in a JSON file.
  for (const sql of [
    "update public.money_release_mode set direct_write_mode = 'strict'",
    "select 1; drop table public.contracts",
    "do $$ begin end $$",
  ]) {
    const broken = copy();
    broken.posture.required_for_app.predicates.push({ name: "sneaky", sql, expect: true });
    assert.ok(
      auditManifest({ manifest: broken, files, hashes, baseline: readBaseline() }).some((problem) =>
        /"sneaky" must be a single read-only select/.test(problem),
      ),
      `accepted: ${sql}`,
    );
  }

  const empty = copy();
  empty.posture.deferred_contract.predicates = [];
  assert.ok(
    auditManifest({ manifest: empty, files, hashes, baseline: readBaseline() }).some((problem) =>
      /posture\.deferred_contract\.predicates must declare at least one/.test(problem),
    ),
  );
});

test("the stamp and the base commit are the migration-history baseline's", () => {
  // Without this, the pending set could be widened or narrowed by editing one
  // number in the manifest.
  const baseline = readBaseline();
  assert.equal(manifest.production_stamp, baseline.newestApplied);
  assert.equal(manifest.base_commit, baseline.baseCommit);

  const invented = copy();
  invented.production_stamp = "20250101000000";
  const problems = auditManifest({ manifest: invented, files, hashes, baseline });
  assert.ok(problems.some((problem) => /is not the newest version in the migration-history baseline/.test(problem)), problems.join("\n"));

  const wrongBase = copy();
  wrongBase.base_commit = "0".repeat(40);
  assert.ok(
    auditManifest({ manifest: wrongBase, files, hashes, baseline }).some((problem) =>
      /is not the migration-history baseline's BASE_COMMIT/.test(problem),
    ),
  );
});

// --- the tool's preconditions ---------------------------------------------

const recordedFor = (entries) =>
  entries.map((entry) => ({ version: entry.version, name: entry.file.replace(/^[0-9]{14}_/, "").replace(/\.sql$/, "") }));

// The size of the expand phase is a property of the manifest, not of this test:
// a release that adds a migration must not have to edit an assertion about how
// many there are, or the assertion starts being maintained instead of trusted.
const EXPAND_COUNT = manifest.required_for_app.length;

test("the contract phase is refused while any expand migration is unapplied", () => {
  const { problems } = planPhase({ manifest, phase: "deferred_contract", recorded: [] });
  assert.ok(
    problems.some((problem) =>
      new RegExp(`may not be applied while ${EXPAND_COUNT} required_for_app migration\\(s\\) are unapplied`).test(problem),
    ),
    problems.join("\n"),
  );

  // One short is still short. This is C6's real content: "applied_verified" must
  // not be satisfiable while a required migration is pending.
  const allButOne = recordedFor(manifestEntries(manifest, "required_for_app").slice(0, -1));
  const short = planPhase({ manifest, phase: "deferred_contract", recorded: allButOne });
  assert.ok(short.problems.some((problem) => /1 required_for_app migration\(s\) are unapplied/.test(problem)));

  // With every expand migration recorded it is allowed, and there is exactly one
  // file to apply.
  const all = recordedFor(manifestEntries(manifest, "required_for_app"));
  const ready = planPhase({ manifest, phase: "deferred_contract", recorded: all });
  assert.deepEqual(ready.problems, []);
  assert.equal(ready.toApply.length, 1);
});

test("the expand phase is refused once the contract phase is recorded", () => {
  const everything = recordedFor(manifestEntries(manifest));
  const { problems } = planPhase({ manifest, phase: "required_for_app", recorded: everything });
  assert.ok(
    problems.some((problem) => /already records the contract phase/.test(problem)),
    problems.join("\n"),
  );
});

test("re-running an applied phase is a no-op, and a renamed version is a refusal", () => {
  const all = recordedFor(manifestEntries(manifest, "required_for_app"));
  const again = planPhase({ manifest, phase: "required_for_app", recorded: all });
  assert.deepEqual(again.problems, []);
  assert.equal(again.toApply.length, 0);
  assert.equal(again.alreadyApplied.length, EXPAND_COUNT);

  const renamed = all.map((row, index) => (index === 0 ? { ...row, name: "something_else" } : row));
  const { problems } = planPhase({ manifest, phase: "required_for_app", recorded: renamed });
  assert.ok(problems.some((problem) => /records 20260806000000 as "something_else"/.test(problem)), problems.join("\n"));
});

test("a phase file that sorts before recorded history is refused, not applied", () => {
  // The CLI applies in filename order, so a migration below the newest recorded
  // version would replay in a different order on a fresh database than it did
  // here. The tool refuses instead of recording that.
  const recorded = [{ version: "20260901000000", name: "something_later" }];
  const { problems } = planPhase({ manifest, phase: "required_for_app", recorded });
  assert.ok(
    problems.some((problem) => /sorts at or before the newest recorded version 20260901000000/.test(problem)),
    problems.join("\n"),
  );
});

// --- statement splitting --------------------------------------------------

test("the splitter respects dollar quoting, comments and strings", () => {
  const sql = [
    "begin;",
    "create function f() returns void language plpgsql as $$",
    "begin",
    "  perform 1; perform 2;",
    "end",
    "$$;",
    "-- a comment with a ; in it",
    "select 'a string with a ; and a $$ in it';",
    "/* a block /* nested */ comment with a ; */",
    'select "a quoted ; identifier";',
    "commit;",
  ].join("\n");
  const statements = splitStatements(sql);
  assert.equal(statements.length, 5, statements.join("\n---\n"));
  assert.equal(statements[0], "begin;");
  assert.ok(statements[1].includes("perform 1; perform 2;"), "the function body was split");
  assert.ok(statements[2].startsWith("-- a comment"), "the comment stayed with its statement");
  assert.equal(statements.at(-1), "commit;");
  assert.ok(statements.every((statement) => statement.endsWith(";")));
});

test("transaction control and non-transactional statements are classified", () => {
  for (const statement of ["begin;", "BEGIN;", "commit;", "end;", "start transaction;", "-- x\nbegin;"]) {
    assert.equal(isTransactionControl(statement), true, statement);
  }
  for (const statement of ["begin\n  perform 1;\nend;", "select 1;", "create table t (x int);"]) {
    assert.equal(isTransactionControl(statement), false, statement);
  }
  assert.equal(nonTransactional("create index concurrently i on t (x);"), true);
  assert.equal(nonTransactional("vacuum analyze t;"), true);
  assert.equal(nonTransactional("create index i on t (x);"), false);
  // A comment that mentions the word must not make a file unapplyable.
  assert.equal(nonTransactional("-- two writers concurrently\nselect 1;"), false);
});

test("every migration in the release splits into applyable statements", () => {
  for (const entry of manifestEntries(manifest)) {
    const sql = readMigration(MIGRATIONS_DIR, entry.file);
    const statements = splitStatements(sql);
    assert.ok(statements.length > 0, `${entry.file} split into nothing`);

    // Nothing is lost but whitespace between statements: the tool records these
    // as the migration's content, and the history row is compared against them.
    const strip = (text) => text.replace(/\s+/g, "");
    assert.equal(
      strip(statements.join("")),
      strip(sql),
      `${entry.file} does not reassemble from its statements`,
    );

    // No statement that cannot run inside a transaction block, or the tool could
    // not apply the file atomically and would refuse it.
    assert.equal(statements.findIndex(nonTransactional), -1, `${entry.file} has a non-transactional statement`);

    // Transaction control is the file's own, and there is at most one pair of it.
    const control = statements.filter(isTransactionControl);
    assert.ok(control.length === 0 || control.length === 2, `${entry.file} declares ${control.length} transaction-control statements`);
    if (control.length === 2) {
      assert.equal(isTransactionControl(statements[0]), true, `${entry.file} does not open with begin;`);
      assert.equal(isTransactionControl(statements.at(-1)), true, `${entry.file} does not close with commit;`);
    }
  }
});

test("the statement fingerprint folds in the count", () => {
  // Otherwise ["a","b"] and ["a b"] collide and a re-split migration compares
  // equal to a differently-split one.
  assert.notEqual(statementsFingerprint(["a", "b"]), statementsFingerprint(["a b"]));
  assert.equal(statementsFingerprint(["a", "b"]), statementsFingerprint(["a", "b"]));
  assert.equal(statementsFingerprint([]).length, 64);
});

test("the drill that tests the tool against a database is committed and wired", () => {
  // The pure functions above cannot prove that a phase applies. The drill can,
  // and a drill that no job runs is not evidence.
  const drill = readFileSync(path.join(ROOT, "scripts/phase-tool-drill.sh"), "utf8");
  assert.match(drill, /db-phase-push\.mjs/);
  assert.match(drill, /phase drill OK/);
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /bash scripts\/phase-tool-drill\.sh/);
  assert.doesNotMatch(
    ci.slice(ci.indexOf("phase-tool-drill.sh") - 400, ci.indexOf("phase-tool-drill.sh")),
    /continue-on-error:\s*true/,
    "a step whose result is discarded is not evidence",
  );
});
