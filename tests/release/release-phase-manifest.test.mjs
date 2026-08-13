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
  breaksOuterTransaction,
  isTransactionControl,
  nonTransactional,
  planPhase,
} from "../../scripts/db-phase-push.mjs";
import { splitSqlStatements } from "../../scripts/split-sql-statements.mjs";
import {
  FINGERPRINT_FORMAT,
  readLocalContent,
  statementsFingerprint,
} from "../../scripts/verify-remote-migration-history.mjs";

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

// --- one statement encoding, shared with the gate that must reproduce it ----

test("the applier carries no private splitter or digest", () => {
  // The history rows this tool writes are the rows
  // scripts/verify-remote-migration-history.mjs later has to reproduce from these
  // same files — that local half is Round-4 C4's closure. This tool used to split
  // with a private splitter that kept the terminating `;`, and hash with the
  // superseded space-joined digest, under a comment claiming it could not collide.
  // Left that way, every version it applied would read back as
  // `content_not_locally_reproducible`; those versions are claimed via
  // --require-applied, so the gate refuses the whole run rather than reporting one
  // row, and C5's post-capture delta — which requires content reproduction — could
  // never admit them. A permanent deploy block, produced by two files disagreeing
  // in private. So the defect is the second copy, not its output, and that is what
  // this test looks for.
  const tool = readFileSync(path.join(ROOT, "scripts/db-phase-push.mjs"), "utf8");
  assert.match(tool, /import \{ splitSqlStatements \} from "\.\/split-sql-statements\.mjs";/);
  assert.match(tool, /statementsFingerprint,\s*\n\} from "\.\/verify-remote-migration-history\.mjs";/);
  assert.match(
    tool,
    /\$\{STATEMENTS_FINGERPRINT_SQL\} as statements_sha256/,
    "the server-side digest is restated instead of interpolated",
  );
  assert.doesNotMatch(
    tool,
    /function\s+(splitStatements|splitSqlStatements|statementsFingerprint)\b/,
    "the applier defines its own statement encoding",
  );
  assert.doesNotMatch(tool, /node:crypto|createHash/, "the applier hashes statements itself");
});

test("the gate's local half is exactly the splitter and the digest", () => {
  // The other end of the coupling, over the committed release. The gate computes
  // its local content with no normalisation of its own: count and fingerprint are
  // splitSqlStatements() and statementsFingerprint() over the file's bytes. Given
  // that, and given the applier now calls the same two functions on the same file,
  // the two sides can only differ if the bytes differ.
  const entries = manifestEntries(manifest);
  const gate = readLocalContent(MIGRATIONS_DIR, entries);
  assert.equal(gate.size, entries.length);
  for (const entry of entries) {
    const local = gate.get(entry.version);
    assert.ok(local, `${entry.file} has no local content`);
    assert.equal(local.error, null, `${entry.file} could not be read (${local.error})`);
    const raw = readFileSync(path.join(MIGRATIONS_DIR, entry.file), "utf8");
    const statements = splitSqlStatements(raw);
    assert.equal(local.count, statements.length, `${entry.file} statement count`);
    assert.equal(local.fingerprint, statementsFingerprint(statements), `${entry.file} fingerprint`);

    // The one byte-level difference between the two sides, asserted rather than
    // assumed: the applier reads through readMigration(), which folds CRLF to LF
    // because that is the form it sends to the server, and the gate reads the file
    // as it is. On the LF checkout CI and every deploy host use they are the same
    // bytes. On a CRLF checkout they are not — and the gate refuses by cause
    // (local_content_line_endings) instead of comparing, which is why this test
    // states the difference here rather than asserting an equality that would hold
    // only on Linux.
    assert.equal(local.crlf, raw.includes("\r\n"), `${entry.file} line-ending report`);
    assert.doesNotMatch(readMigration(MIGRATIONS_DIR, entry.file), /\r\n/);
  }
});

test("transaction control and non-transactional statements are classified", () => {
  // Both spellings, because the splitter hands these over without the terminating
  // `;` — the semicolon-bearing forms are only what a reader would type.
  for (const statement of [
    "begin",
    "BEGIN",
    "commit",
    "end",
    "start transaction",
    "-- x\nbegin",
    "begin;",
    "commit;",
    "-- x\nbegin;",
  ]) {
    assert.equal(isTransactionControl(statement), true, statement);
  }
  for (const statement of ["begin\n  perform 1;\nend", "begin\n  perform 1;\nend;", "select 1", "create table t (x int);"]) {
    assert.equal(isTransactionControl(statement), false, statement);
  }
  assert.equal(nonTransactional("create index concurrently i on t (x);"), true);
  assert.equal(nonTransactional("vacuum analyze t;"), true);
  assert.equal(nonTransactional("create index i on t (x);"), false);
  // A comment that mentions the word must not make a file unapplyable.
  assert.equal(nonTransactional("-- two writers concurrently\nselect 1;"), false);
});

test("every way of breaking the outer transaction is refused, and named", () => {
  // Round-4 C4-6. isTransactionControl() answers "may this be skipped", and
  // everything it said no to was executed — including `rollback`, which does not
  // merely discard the migration: it ends the block, so the history row that
  // follows commits on its own. That is a version recorded as applied with nothing
  // it created in the database, and a recorded version is never applied again, so
  // the phase is "already applied" forever with the objects missing. Measured on
  // PostgreSQL 17.10 in scripts/phase-tool-drill.sh, which reproduces exactly that
  // state with this classifier neutered.
  //
  // The keyword is returned rather than the statement, because the caller prints it.
  for (const [statement, keyword] of [
    ["rollback", "rollback"],
    ["ROLLBACK;", "rollback"],
    ["rollback to savepoint s1;", "rollback"],
    ["rollback prepared 'g';", "rollback"],
    ["abort;", "abort"],
    ["abort transaction;", "abort"],
    ["savepoint s1;", "savepoint"],
    ["release savepoint s1;", "release"],
    ["release s1;", "release"],
    ["commit and chain;", "commit"],
    ["commit prepared 'g';", "commit"],
    ["rollback and chain;", "rollback"],
    ["end and chain;", "end"],
    ["prepare transaction 'g';", "prepare transaction"],
    ["discard all;", "discard"],
    ["discard plans;", "discard"],
    ["set transaction read only;", "set transaction"],
    ["set transaction isolation level serializable;", "set transaction"],
    ["set constraints all deferred;", "set constraints"],
    ["set session characteristics as transaction read only;", "set session characteristics"],
    ["begin isolation level serializable;", "begin"],
    ["start transaction read write;", "start"],
    ["-- harmless\nrollback;", "rollback"],
    ["/* harmless */ savepoint s1;", "savepoint"],
    ["Begin Isolation Level Repeatable Read", "begin"],
  ]) {
    assert.equal(breaksOuterTransaction(statement), keyword, statement);
  }

  // The two forms the tool skips, and nothing else, are allowed through. These are
  // the file's own outer transaction, which the tool replaces with its own.
  for (const statement of ["begin", "BEGIN", "begin;", "begin work", "begin transaction", "start transaction", "commit", "commit;", "commit work", "end", "end transaction", "-- x\ncommit;"]) {
    assert.equal(breaksOuterTransaction(statement), null, statement);
    assert.equal(isTransactionControl(statement), true, statement);
  }

  // Ordinary SQL is untouched, including statements whose text mentions the
  // vocabulary somewhere other than the first keyword: classification is on the
  // statement's leading keyword, and a word inside a literal or an identifier is
  // not that.
  for (const statement of [
    "select 1",
    "create table t (x int);",
    "select 'rollback';",
    "comment on function f() is 'call rollback first';",
    "create table savepoints (id int);",
    "insert into release_notes (body) values ('abort');",
    "update t set x = 1 where note = 'discard all';",
    "grant execute on function public.f() to service_role;",
    "create or replace function f() returns void language plpgsql as $$ begin perform 1; end $$;",
  ]) {
    assert.equal(breaksOuterTransaction(statement), null, statement);
  }

  // Fail-closed where the two disagree: a statement whose first keyword is `begin`
  // but which is not exactly the skippable form is refused rather than sent. That
  // is deliberate — the tool cannot tell an isolation-level BEGIN from the file's
  // own one without deciding, and deciding wrong here means a transaction it does
  // not control. No statement in this release is affected; the next test measures
  // that rather than assuming it.
  assert.equal(isTransactionControl("begin isolation level serializable"), false);
  assert.equal(breaksOuterTransaction("begin isolation level serializable"), "begin");
});

test("no statement in this release is refused by that classifier", () => {
  // The other half of a fail-closed guard: it has to be measured against the thing
  // it guards, or a guard that refuses everything would pass the test above. Every
  // statement of every migration the release ships, plus the hand-run companions,
  // because those are applied by an operator through the same rules.
  let skipped = 0;
  let total = 0;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of splitSqlStatements(readMigration(MIGRATIONS_DIR, file))) {
      total += 1;
      if (isTransactionControl(statement)) {
        skipped += 1;
        continue;
      }
      assert.equal(
        breaksOuterTransaction(statement),
        null,
        `${file} has a statement this tool would refuse`,
      );
    }
  }
  assert.ok(total > 1000, `only ${total} statements measured, which is too few to mean anything`);
  assert.ok(skipped > 0, "no transaction control was skipped, so the skip path was not measured");
});

test("the refusal is for the whole phase, and again at the line that would send it", () => {
  const tool = readFileSync(path.join(ROOT, "scripts/db-phase-push.mjs"), "utf8");
  // Before anything is applied: a phase with one such statement in its last file
  // must not apply the files before it. The drill measures this against a database
  // (0 history rows after each of eight mutations); here it is pinned to the shape
  // that makes it true — the same loop as the nonTransactional refusal, above the
  // apply loop.
  const shapeRefusals = tool.indexOf("Shape refusals for the whole phase first");
  // Two loops over toApply: the shape pass, then the apply pass. The second one is
  // the boundary this test is about.
  const shapePass = tool.indexOf("for (const entry of toApply) {", shapeRefusals + 1);
  const applyLoop = tool.indexOf("for (const entry of toApply) {", shapePass + 1);
  const breaking = tool.indexOf("const breaking = statements.findIndex");
  assert.ok(shapeRefusals > 0 && shapePass > 0 && applyLoop > shapePass && breaking > 0);
  assert.ok(
    breaking > shapeRefusals && breaking < applyLoop,
    "the transaction-control refusal is not in the pre-apply pass",
  );
  assert.match(tool, /cannot honour \(\$\{breaksOuterTransaction\(statements\[breaking\]\)\}\)/);
  // And again inside the loop, at the line that would send it, so a future caller
  // reaching the apply loop by another route cannot cross the guarantee.
  assert.match(tool, /code: "transaction_control_in_apply"/);
  assert.ok(
    tool.indexOf('code: "transaction_control_in_apply"') > applyLoop,
    "the defence-in-depth check is not inside the apply loop",
  );

  // Read-after-write fails closed on both new refusals: a file this release ships
  // that cannot be fingerprinted, and a row the server declined to fingerprint.
  assert.match(tool, /error\.code !== "unfingerprintable_statements"/);
  assert.match(tool, /row\.statement_count === null \|\| row\.statements_sha256 === null/);
});

test("every migration in the release splits into applyable statements", () => {
  for (const entry of manifestEntries(manifest)) {
    const sql = readMigration(MIGRATIONS_DIR, entry.file);
    const statements = splitSqlStatements(sql);
    assert.ok(statements.length > 0, `${entry.file} split into nothing`);

    // Nothing is lost but whitespace and the separators themselves: the tool
    // records these as the migration's content, and the history row is compared
    // against them. The terminating `;` is dropped because the CLI drops it — a
    // separator inside a string or a comment is not a separator and stays, which is
    // why both sides are compared with semicolons removed rather than with the
    // array re-joined on one.
    const strip = (text) => text.replace(/[\s;]+/g, "");
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

test("the statement fingerprint separates arrays a count cannot", () => {
  // The digest this tool now uses is length-delimited, so every boundary is in the
  // hashed bytes. The superseded form folded in the count and then joined on a
  // space, which separates ["a","b"] from ["a b"] but NOT ["a","b c"] from
  // ["a b","c"]: same count, moved boundary, identical digest. That is a migration
  // recorded with a different split reading back as content this release
  // reproduces, which is the one thing the fingerprint exists to prevent.
  assert.equal(FINGERPRINT_FORMAT, "statements-v2-length-delimited");
  assert.notEqual(statementsFingerprint(["a", "b"]), statementsFingerprint(["a b"]));
  assert.notEqual(statementsFingerprint(["a", "b c"]), statementsFingerprint(["a b", "c"]));
  assert.equal(statementsFingerprint(["a", "b"]), statementsFingerprint(["a", "b"]));
  assert.equal(statementsFingerprint([]).length, 64);
});

test("the drill that tests the tool against a database is committed and wired", () => {
  // The pure functions above cannot prove that a phase applies. The drill can,
  // and a drill that no job runs is not evidence.
  const drill = readFileSync(path.join(ROOT, "scripts/phase-tool-drill.sh"), "utf8");
  assert.match(drill, /db-phase-push\.mjs/);
  assert.match(drill, /phase drill OK/);
  // The one step the offline tests above cannot stand in for: the rows the applier
  // writes, read back through the gate's own query and digest, with a perturbation
  // it is required to catch. Asserted here so it cannot be quietly dropped from the
  // drill while the drill keeps exiting 0.
  assert.match(drill, /verify-remote-migration-history\.mjs/);
  assert.match(drill, /cross_tool_check \|\| fail/);
  assert.match(drill, /it is not measuring content/);

  // Round-4 C4-6's mutation step. The offline tests above hold the classifier to a
  // list of statements; only a database can show what the classifier is worth, so
  // the drill injects each form into a copy of a real release tree and requires the
  // whole phase refused with nothing recorded — then neuters the classifier in that
  // copy and requires the damage to appear. Pinned from outside because a drill can
  // keep exiting 0 with a step quietly removed.
  for (const statement of [
    "rollback;",
    "abort;",
    "savepoint s1;",
    "release savepoint s1;",
    "commit and chain;",
    "prepare transaction 'phase-drill';",
    "set transaction read only;",
    "discard all;",
  ]) {
    assert.ok(
      drill.includes(`mutate_and_run "${statement}"`),
      `the drill does not inject ${statement}`,
    );
  }
  assert.match(drill, /the rollback probe did not demonstrate the hazard on this server/);
  assert.match(drill, /the tool applied a phase containing \$keyword/);
  assert.match(drill, /was refused but \$rows history row\(s\) were written/);
  assert.match(drill, /check-release-manifest\.mjs" --stamp/, "a hash mismatch would refuse for the wrong reason");
  assert.match(drill, /the unmutated tree did not apply: the refusals above prove nothing/);
  assert.match(drill, /the superseded classifier did not reproduce the hazard/);
  assert.match(drill, /neutered by the drill/);
  assert.match(drill, /12 steps, 4 databases/);
  // The mutation happens in a copy under $WORK. C7's constraint is that the drill
  // edits nothing in the repository, and a mutation step is the one place that could
  // quietly stop being true.
  assert.match(drill, /MUTANT="\$WORK\/release-mutant"/);
  assert.doesNotMatch(drill, /MUTANT_FILE="\$ROOT/);

  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /bash scripts\/phase-tool-drill\.sh/);
  assert.doesNotMatch(
    ci.slice(ci.indexOf("phase-tool-drill.sh") - 400, ci.indexOf("phase-tool-drill.sh")),
    /continue-on-error:\s*true/,
    "a step whose result is discarded is not evidence",
  );
});
