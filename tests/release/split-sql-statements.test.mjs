// ============================================================================
// Round-4 C4: the local half of the migration content proof
// ============================================================================
// scripts/split-sql-statements.mjs turns a migration file into the statement array
// the Supabase CLI records for it, so that the remote-history gate can compare
// production's recorded statements with this release's own files. Its correctness
// is not "matches PostgreSQL" — it is "matches the CLI", and those are not the
// same thing. Two of the assertions below are the CLI being wrong about SQL, and
// the splitter has to be wrong the same way or the gate reports content drift for
// a file production applied exactly.
//
// The authority for every case here is a measurement, not a reading of the CLI's
// source, which this repository does not vendor:
// scripts/verify-cli-statement-parity.mjs applies the same corpus with the pinned
// CLI and requires this module to reproduce what it recorded. That drill runs in
// the `local-database` job of .github/workflows/ci.yml with CLI 2.113.0. This file
// is the fast, offline copy of its expectations — it keeps a regression from
// reaching the drill, and it documents which behaviours are load-bearing.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { splitSqlStatements } from "../../scripts/split-sql-statements.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("the separator is not part of the statement", () => {
  assert.deepEqual(splitSqlStatements("select 1;\nselect 2;\n"), ["select 1", "select 2"]);
  assert.deepEqual(splitSqlStatements("select 1;\nselect 2\n"), ["select 1", "select 2"]);
  // Measured: CLI 2.113.0 records ["select 1", "select 2"] for both of these.
  // Keeping the `;` was this module's original behaviour and made every single
  // statement of every migration differ from what production recorded.
});

test("empty statements are dropped, not recorded", () => {
  assert.deepEqual(splitSqlStatements("select 1;;\n\n\nselect 2;\n\n;\n"), ["select 1", "select 2"]);
  assert.deepEqual(splitSqlStatements(""), []);
  assert.deepEqual(splitSqlStatements("\n\n   \n"), []);
  assert.deepEqual(splitSqlStatements(";"), []);
});

test("whitespace is trimmed, including the CR of a CRLF checkout", () => {
  assert.deepEqual(splitSqlStatements("select 1;\r\nselect 2;\r\n"), ["select 1", "select 2"]);
  // But a CR inside a statement survives, because the recorded bytes did:
  assert.deepEqual(splitSqlStatements("select 1,\r\n  2;\n"), ["select 1,\r\n  2"]);
  // which is why scripts/verify-remote-migration-history.mjs refuses a CRLF
  // checkout outright instead of comparing content against rewritten files.
});

test("a semicolon inside a comment is not a separator", () => {
  assert.deepEqual(splitSqlStatements("-- a comment; here\nselect 1;\n"), ["-- a comment; here\nselect 1"]);
  assert.deepEqual(splitSqlStatements("select 1; -- trailing;\n"), ["select 1", "-- trailing;"]);
  assert.deepEqual(splitSqlStatements("/* block; comment */\nselect 1;\n"), ["/* block; comment */\nselect 1"]);
  assert.deepEqual(splitSqlStatements("/* outer; /* inner; */ still outer; */\nselect 1;\n"), [
    "/* outer; /* inner; */ still outer; */\nselect 1",
  ]);
  // A line comment that is the last thing in the file is still a statement the CLI
  // records, semicolon and all, because that semicolon never separated anything.
  assert.deepEqual(splitSqlStatements("select 1;\n-- trailing comment"), ["select 1", "-- trailing comment"]);
});

test("a semicolon inside a string or an identifier is not a separator", () => {
  assert.deepEqual(splitSqlStatements("select 'a;b';\nselect 2;\n"), ["select 'a;b'", "select 2"]);
  assert.deepEqual(splitSqlStatements("select 'it''s; fine';\nselect 2;\n"), ["select 'it''s; fine'", "select 2"]);
  assert.deepEqual(splitSqlStatements('create table "t;semi" (id int);\nselect 1;\n'), [
    'create table "t;semi" (id int)',
    "select 1",
  ]);
  assert.deepEqual(splitSqlStatements('create table "t""q;uote" (id int);\nselect 1;\n'), [
    'create table "t""q;uote" (id int)',
    "select 1",
  ]);
});

test("a backslash is an ordinary character in a string, even inside E''", () => {
  // Standard SQL, and the CLI agrees: 'a\' is a complete string.
  assert.deepEqual(splitSqlStatements("select 'a\\';\nselect 2;\n"), ["select 'a\\'", "select 2"]);
  // And here the CLI does NOT agree with PostgreSQL. E'a\'b' is one string to the
  // server; to the CLI the quote after the backslash closes, the quote before the
  // `;` opens a string that never terminates, and the whole file becomes a single
  // recorded statement — trailing semicolon included, because that semicolon was
  // inside the unterminated string and never separated anything. Measured: CLI
  // 2.113.0 records exactly ["select E'a\\'b';\nselect 2;"] for this file.
  assert.deepEqual(splitSqlStatements("select E'a\\'b';\nselect 2;\n"), ["select E'a\\'b';\nselect 2;"]);
});

test("dollar quoting is opaque and tags must match exactly", () => {
  assert.deepEqual(
    splitSqlStatements("create function f() returns int language plpgsql as $$\nbegin\n  perform 1;\n  return 1;\nend\n$$;\nselect f();\n"),
    ["create function f() returns int language plpgsql as $$\nbegin\n  perform 1;\n  return 1;\nend\n$$", "select f()"],
  );
  assert.deepEqual(
    splitSqlStatements("create function g() returns text language plpgsql as $fn$\nbegin\n  return $$inner; text$$;\nend\n$fn$;\nselect g();\n"),
    ["create function g() returns text language plpgsql as $fn$\nbegin\n  return $$inner; text$$;\nend\n$fn$", "select g()"],
  );
  assert.deepEqual(splitSqlStatements("do $$ begin perform 1; end $$;\nselect 1;\n"), [
    "do $$ begin perform 1; end $$",
    "select 1",
  ]);
});

test("a dollar sign that is not a quote does not open one", () => {
  // $1 is a parameter placeholder. A splitter that opened a quote at `$1$` would
  // run past every following separator.
  assert.deepEqual(splitSqlStatements("create function h(int) returns int language sql as 'select $1';\nselect h(1);\n"), [
    "create function h(int) returns int language sql as 'select $1'",
    "select h(1)",
  ]);
  assert.deepEqual(splitSqlStatements("select 1 + 2;\nselect $1$a$1$;\n")[0], "select 1 + 2");
});

test("an unterminated quote runs to end of file as one statement", () => {
  // Not a repair: the CLI would hand this to the server and the server would
  // reject it, so one unsplit statement is the honest representation of what was
  // sent. The gate that consumes this then reports a difference, which is a
  // refusal rather than a claim.
  assert.deepEqual(splitSqlStatements("select 'unterminated;\nselect 2;\n"), ["select 'unterminated;\nselect 2;"]);
  assert.deepEqual(splitSqlStatements("select $tag$ unterminated;\nselect 2;\n"), [
    "select $tag$ unterminated;\nselect 2;",
  ]);
  assert.deepEqual(splitSqlStatements("/* unterminated;\nselect 2;\n"), ["/* unterminated;\nselect 2;"]);
});

test("every migration in this release splits into at least one statement", () => {
  // A migration that parses into nothing cannot be the source of anything
  // production recorded, and the gate says so per row. This asserts the release
  // does not currently contain such a file — a stronger and cheaper statement
  // than any single fixture.
  const dir = path.join(ROOT, "supabase", "migrations");
  const files = readFileSync(path.join(ROOT, "supabase", "migration-history-baseline.sha256"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/).at(-1))
    .filter((file) => typeof file === "string" && /^[0-9]{14}_.+\.sql$/.test(path.basename(file)));
  assert.ok(files.length > 0, "the baseline lists applied migrations");
  for (const file of files) {
    const sql = readFileSync(path.join(dir, path.basename(file)), "utf8");
    const statements = splitSqlStatements(sql);
    assert.ok(statements.length > 0, `${file} splits into no statements`);
    for (const statement of statements) {
      assert.equal(statement, statement.trim(), `${file} produced an untrimmed statement`);
      assert.notEqual(statement, "", `${file} produced an empty statement`);
    }
  }
});

test("the module's claim about how it is verified names a drill that exists", () => {
  const source = read("scripts/split-sql-statements.mjs");
  assert.match(source, /scripts\/verify-cli-statement-parity\.mjs/);
  assert.ok(read("scripts/verify-cli-statement-parity.mjs").length > 0);
  // And the pinned version the drill establishes parity for must be the version
  // the job that runs it installs. Parity is per CLI version and for no other.
  const ci = read(".github/workflows/ci.yml");
  const job = ci.slice(ci.indexOf("  local-database:"), ci.indexOf("  migration-replay:"));
  assert.match(job, /version: 2\.113\.0/);
  assert.match(job, /node scripts\/verify-cli-statement-parity\.mjs/);
});
