/**
 * Behaviour of the gate that compares a release's migration directory against the
 * history the target database recorded (scripts/verify-remote-migration-history.mjs).
 *
 * The comparison is a pure function, so it is executed here with fixture
 * histories rather than described: every case is a shape that must be REFUSED,
 * plus the one that must pass. A gate in the canonical deploy path that has never
 * been shown to go red is the pattern this release exists to remove.
 *
 * The CLI surface is exercised separately for the two things that are security
 * properties rather than logic: a connection string may not arrive as an
 * argument, and a missing --url-file may not degrade to a skip.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareHistories,
  readLocalMigrations,
} from "../../scripts/verify-remote-migration-history.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/verify-remote-migration-history.mjs");

const APPLIED = [
  { version: "20260101000000", name: "first" },
  { version: "20260102000000", name: "second" },
];
const LOCAL = [
  { version: "20260101000000", name: "first", file: "20260101000000_first.sql" },
  { version: "20260102000000", name: "second", file: "20260102000000_second.sql" },
];
const PENDING = { version: "20260813000000", name: "session_boundary", file: "20260813000000_session_boundary.sql" };

const problemsFor = (overrides) =>
  compareHistories({ remote: APPLIED, local: LOCAL, ...overrides });

test("a release whose applied history matches, with forward-only pending work, passes", () => {
  assert.deepEqual(problemsFor({ local: [...LOCAL, PENDING] }), []);
  assert.deepEqual(problemsFor({}), []);
});

test("a renamed applied migration is refused, naming both names", () => {
  const problems = problemsFor({
    local: [{ version: "20260102000000", name: "second_renamed", file: "20260102000000_second_renamed.sql" }, LOCAL[0]],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /applied 20260102000000 as "second" but this release calls it "second_renamed"/);
  assert.match(problems[0], /renamed/);
});

test("an applied migration missing from the release is refused", () => {
  const problems = problemsFor({ local: [LOCAL[0]] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /applied 20260102000000 .* but this release contains no such migration/);
});

test("an empty remote history is refused rather than trivially satisfied", () => {
  // The dangerous default: comparing against nothing matches everything.
  const problems = compareHistories({ remote: [], local: LOCAL });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /zero applied migrations/);
});

test("an applied_verified claim is re-measured against the database", () => {
  // Claimed applied, database has never heard of it.
  let problems = problemsFor({
    local: [...LOCAL, PENDING],
    requireApplied: ["20260813000000_session_boundary"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /claimed applied but the database has no record of 20260813000000/);

  // Claimed applied, and the database agrees.
  problems = problemsFor({ requireApplied: ["20260102000000_second"] });
  assert.deepEqual(problems, []);

  // Claimed applied, but the release does not even contain it.
  problems = problemsFor({ requireApplied: ["20260709000000_ghost"] });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /this release contains no migration 20260709000000/);
  assert.match(problems[1], /the database has no record of 20260709000000/);

  // A bare version is the same claim as a full stem.
  assert.deepEqual(problemsFor({ requireApplied: ["20260102000000"] }), []);

  // Anything that is not a migration id at all is refused, not skipped.
  problems = problemsFor({ requireApplied: ["latest"] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a migration id this gate can check/);
});

test("a not_required claim is refused when the release carries unapplied migrations", () => {
  const problems = problemsFor({ local: [...LOCAL, PENDING], requireNoPending: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /declared to need no migrations, but 1 migration\(s\)/);
  assert.match(problems[0], /20260813000000_session_boundary\.sql/);

  // And accepted when the release genuinely carries none.
  assert.deepEqual(problemsFor({ requireNoPending: true }), []);
});

test("an unapplied migration that sorts before applied history is refused", () => {
  // The CLI applies in filename order, so this one is not "pending", it is
  // unreachable — and its absence would otherwise look like normal pending work.
  const problems = problemsFor({
    local: [...LOCAL, { version: "20260101120000", name: "backdated", file: "20260101120000_backdated.sql" }],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /sorts at or before the newest applied version 20260102000000/);
});

test("a history row with no recorded name is not treated as a rename", () => {
  // `supabase migration repair` can leave the name column empty. That is not
  // evidence of a rewrite, so it must not be reported as one — while a WRONG
  // name still is (asserted above).
  assert.deepEqual(
    problemsFor({ remote: [{ version: "20260101000000", name: null }, { version: "20260102000000", name: "" }] }),
    [],
  );
});

test("a malformed or duplicated remote history is refused", () => {
  let problems = problemsFor({ remote: [...APPLIED, { version: "20260102000000", name: "second" }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /records version 20260102000000 twice/);

  problems = problemsFor({ remote: [...APPLIED, { version: "1780601210", name: "epoch" }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a 14-digit CLI stamp/);
});

test("only the files the Supabase CLI would apply are compared", () => {
  const local = readLocalMigrations(path.join(ROOT, "supabase", "migrations"));
  assert.ok(local.length > 100, `expected this checkout's applied history, got ${local.length}`);
  for (const entry of local) {
    assert.match(entry.file, /^[0-9]{14}_.+\.sql$/);
  }
  // rollback_*.sql is inert for the CLI and must not enter the comparison.
  const names = new Set(local.map((entry) => entry.file));
  const rollbacks = fs
    .readdirSync(path.join(ROOT, "supabase", "migrations"))
    .filter((file) => file.startsWith("rollback_"));
  assert.ok(rollbacks.length > 0, "expected at least one rollback companion in this checkout");
  for (const file of rollbacks) assert.equal(names.has(file), false);
  // Sorted, because order is what "forward-only" is measured against.
  assert.deepEqual([...local.map((entry) => entry.file)].sort(), local.map((entry) => entry.file));
});

const runCli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });

test("a connection string cannot be passed as an argument", () => {
  // Arguments are readable from /proc by any local user for the life of the
  // process, and land in shell history. The URL comes from a file or not at all.
  for (const arg of ["--url=postgres://u:p@h/db", "postgresql://u:p@h/db"]) {
    const result = runCli([arg]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be read from a file, never passed as an argument/);
    assert.doesNotMatch(result.stdout, /postgres/);
  }
});

test("a missing --url-file is a failure, not a skip", () => {
  const missing = runCli([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--url-file is required/);

  const absent = runCli(["--url-file", path.join(ROOT, "does-not-exist.url")]);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /remote migration history:/);

  const unknown = runCli(["--url-file", "x", "--pretend-everything-is-fine"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown argument/);
});
