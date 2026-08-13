/**
 * Measure that the two statement-fingerprint implementations agree.
 *
 * Round-4 finding C4. The remote-history gate proves "production ran this
 * release's SQL" by comparing two digests of the same statement array:
 *
 *   * the server computes one, inside HISTORY_QUERY, over the `text[]` the
 *     Supabase CLI recorded in supabase_migrations.schema_migrations
 *   * this repository computes the other, in statementsFingerprint(), over the
 *     statements splitSqlStatements() parses out of the release's own .sql file
 *
 * The statement text never crosses the wire, which is the point — and also the
 * reason the two encodings can drift apart without anyone noticing. If they
 * disagree, the gate reports content drift in a production database where none
 * happened (a false accusation that blocks a correct deploy) or, worse, matches
 * where the bytes differ. Neither failure is visible by reading either side.
 *
 * So it is measured, here, against a real PostgreSQL of the major version
 * production runs, over:
 *
 *   1. adversarial vectors, including the pair the previous encoding collided on
 *      (`["a","b c"]` and `["a b","c"]`: same count, same space-joined text, a
 *      moved statement boundary — exactly the drift the gate exists to catch)
 *   2. every migration file in this release, parsed by splitSqlStatements() and
 *      recorded as if the CLI had applied it — a hundred-odd rows of real
 *      dollar-quoted bodies, unicode comments and embedded quotes
 *
 * Scope of the claim. This drill measures SQL-vs-JS agreement on a given array.
 * It says nothing about whether splitSqlStatements() produces the array the CLI
 * would have produced for a file; that is a separate measurement, against the
 * pinned CLI, in scripts/verify-cli-statement-parity.mjs.
 *
 * One divergence is known and deliberately not papered over: `statements` is
 * `text[]`, so a multidimensional value is representable, and for one the server
 * would count `array_length(...,1)` (the first dimension) while `unnest`
 * flattens and the JS side has no notion of dimensions at all. The CLI does not
 * write such a value. If one ever appeared, count and content would disagree and
 * the gate would report a difference — a refusal, which is the safe direction —
 * so this drill does not carry a vector claiming parity for it.
 *
 * A drill that measured nothing would also exit 0, which this repository has
 * already booked once as F-05. So `--self-test` runs the same comparison with the
 * JS side deliberately computed through the superseded space-joined encoding, and
 * requires every row to be reported as a difference. A harness that cannot see a
 * whole encoding change cannot see a one-byte one either.
 *
 * Safety. The only accepted argument is `--self-test`; no connection string is
 * ever passed or read. The target comes from the standard PG* environment only,
 * and must be loopback, because this script creates a table and inserts rows.
 * Everything it does happens inside one transaction that is always rolled back,
 * so it leaves nothing behind even on the throwaway database it insists on.
 *
 * Usage (CI, .github/workflows/ci.yml job `migration-replay`):
 *   createdb parity
 *   PGDATABASE=parity node scripts/statements-fingerprint-parity.mjs --self-test
 *   PGDATABASE=parity node scripts/statements-fingerprint-parity.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  FINGERPRINT_FORMAT,
  HISTORY_QUERY,
  statementsFingerprint,
} from "./verify-remote-migration-history.mjs";
import { splitSqlStatements } from "./split-sql-statements.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const CLI_MIGRATION = /^([0-9]{14})_(.+)\.sql$/;

/**
 * The cases that break naive encodings. `statements: null` is the SQL NULL
 * column, which must fingerprint as the empty array on both sides — production
 * has rows with nothing recorded, and the gate's decision about them depends on
 * measuring them the same way twice.
 */
const VECTORS = [
  { label: "moved boundary A", statements: ["a", "b c"] },
  { label: "moved boundary B", statements: ["a b", "c"] },
  { label: "framing attack A", statements: ["1\n1", "x"] },
  { label: "framing attack B", statements: ["3\n1", "1\n1\nx"] },
  { label: "empty array", statements: [] },
  { label: "single space element", statements: [" "] },
  { label: "adjacent lengths", statements: ["1", "12", "123"] },
  { label: "embedded quote", statements: ["select 'it''s';"] },
  { label: "newline", statements: ["select 1;\nselect 2;"] },
  { label: "carriage return", statements: ["select 1;\r\nselect 2;"] },
  { label: "tab", statements: ["select\t1;"] },
  { label: "multi-byte text", statements: ["-- 迁移 · émoji 🚀\nselect 1;"] },
  { label: "dollar quoted", statements: ["create function f() returns int as $$ begin return 1; end $$ language plpgsql;"] },
  { label: "two elements", statements: ["a", "b"] },
  { label: "four elements", statements: ["a", "b", "c", "d"] },

  // Round-4 C4-6. Values `text[]` admits and this release cannot produce, each
  // of which the previous expression coerced into a digest — and each of which
  // then collided with a value above. `sql` is the literal the row is inserted
  // with, because a multidimensional array and a non-standard lower bound cannot
  // be expressed through a bound parameter at all; `statements` is what the JS
  // side is asked to fingerprint, and `refused` says both sides must decline.
  { label: "null column", statements: null, sql: "null", refused: true },
  { label: "null element", statements: ["ok", null], sql: "array['ok',null]::text[]", refused: true },
  // The value the one above collided with: same count, and the same bytes once a
  // missing element was coerced to an empty one. Both are refused now, and the pair
  // is what MUST_NOT_COLLIDE measures.
  { label: "empty element twin", statements: ["ok", ""], sql: "array['ok','']::text[]", refused: true },
  { label: "empty element", statements: ["", "select 1;"], sql: "array['','select 1;']::text[]", refused: true },
  { label: "two dimensional 2x1", statements: [["a"], ["b"]], sql: "array[array['a'],array['b']]::text[]", refused: true },
  { label: "two dimensional 2x2", statements: [["a", "b"], ["c", "d"]], sql: "array[array['a','b'],array['c','d']]::text[]", refused: true },
  // `serverOnly`, not `refused`: a lower bound has no JavaScript counterpart, so
  // the JS side is handed the flattened equivalent — the collision partner itself —
  // and the server's refusal is the entire defence.
  { label: "lower bound zero", statements: ["a", "b"], sql: "'[0:1]={a,b}'::text[]", serverOnly: true },
  { label: "lower bound five", statements: ["a", "b"], sql: "'[5:6]={a,b}'::text[]", serverOnly: true },
];

/** Pairs that must NOT share a digest, whatever the encoding does elsewhere. */
const MUST_DIFFER = [
  ["moved boundary A", "moved boundary B"],
  ["framing attack A", "framing attack B"],
];

/**
 * The collisions round-4 C4-6 found in the previous expression, as measured on
 * PostgreSQL 17.10: each pair came back with the same statement_count and the same
 * digest, so a history row holding the left value satisfied a claim about the right
 * one. They are listed as pairs rather than as "these values must be refused"
 * because that is the property that matters — and because the harness proves it can
 * see them: SUPERSEDED_FINGERPRINT_SQL below is the expression this one replaced,
 * evaluated in the same query, and every pair here is required to collide under it.
 * A domain check that no longer detects anything is then a failure rather than a
 * silent pass.
 */
const MUST_NOT_COLLIDE = [
  ["null element", "empty element twin"],
  ["null column", "empty array"],
  ["two elements", "two dimensional 2x1"],
  ["two elements", "lower bound zero"],
  ["two elements", "lower bound five"],
];

/**
 * The count and digest expression as it stood before C4-6, kept here and nowhere
 * else: it is the negative control for MUST_NOT_COLLIDE, not a code path.
 */
const SUPERSEDED_FINGERPRINT_SQL = `encode(sha256(
         convert_to(coalesce(array_length(m.statements, 1), 0)::text || E'\\n', 'UTF8') ||
         coalesce((select string_agg(
                            convert_to(octet_length(convert_to(coalesce(s.statement, ''), 'UTF8'))::text || E'\\n', 'UTF8')
                              || convert_to(coalesce(s.statement, ''), 'UTF8'),
                            ''::bytea order by s.ord)
                     from unnest(m.statements) with ordinality as s(statement, ord)),
                  ''::bytea)
       ), 'hex')`;

const SUPERSEDED_QUERY = `select m.version,
       coalesce(array_length(m.statements, 1), 0) as statement_count,
       ${SUPERSEDED_FINGERPRINT_SQL} as statements_sha256
  from supabase_migrations.schema_migrations m
 order by m.version`;

/**
 * The encoding this one replaced: `count || ' ' || array_to_string(statements,' ')`
 * on both sides. Used only by --self-test, as a known-wrong JS side that the
 * harness must report as a difference on every row.
 */
function supersededFingerprint(statements) {
  const list = Array.isArray(statements) ? statements : [];
  return crypto
    .createHash("sha256")
    .update(`${list.length}`)
    .update(list.map((statement) => ` ${statement ?? ""}`).join(""))
    .digest("hex");
}

function loadPg() {
  return createRequire(fileURLToPath(import.meta.url))("pg");
}

/**
 * The target, from the environment. `pg` reads PGHOST/PGPORT/PGUSER/PGDATABASE
 * itself; this only decides whether it is allowed to.
 */
function assertLocalTarget() {
  const host = (process.env.PGHOST ?? "").trim();
  const local =
    host === "" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("/");
  if (!local) {
    throw new Error(
      `refusing to run against PGHOST=${host}: this drill writes rows and only runs against a loopback throwaway database`,
    );
  }
  if (process.env.PGPASSWORD || process.env.PGPASSFILE) {
    throw new Error(
      "refusing: a password is configured for this target, which a throwaway drill database does not have",
    );
  }
}

function readMigrationVectors() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => CLI_MIGRATION.test(file))
    .sort()
    .map((file) => ({
      label: file,
      version: file.match(CLI_MIGRATION)[1],
      statements: splitSqlStatements(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")),
    }));
}

async function main({ selfTest }) {
  assertLocalTarget();
  const fingerprint = selfTest ? supersededFingerprint : statementsFingerprint;

  const synthetic = VECTORS.map((vector, index) => ({
    ...vector,
    version: `00000000000${String(index).padStart(3, "0")}`,
  }));
  const fromFiles = readMigrationVectors();
  if (fromFiles.length === 0) {
    throw new Error(`no CLI migrations found under ${MIGRATIONS_DIR}: there is nothing to measure`);
  }
  const cases = [...synthetic, ...fromFiles];

  const { Client } = loadPg();
  const client = new Client({
    application_name: "newme-statements-fingerprint-parity",
    statement_timeout: 60000,
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`could not connect to the drill database (${error.code ?? error.name})`);
  }

  let failures = 0;
  try {
    await client.query("begin");

    // A drill that polluted a real history would be a drill nobody could run
    // twice. Refuse rather than mix this run's vectors into recorded rows.
    const existing = await client.query(
      "select count(*)::int as rows from information_schema.tables where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'",
    );
    if (existing.rows[0].rows > 0) {
      const recorded = await client.query("select count(*)::int as rows from supabase_migrations.schema_migrations");
      if (recorded.rows[0].rows > 0) {
        throw new Error(
          `refusing: supabase_migrations.schema_migrations already holds ${recorded.rows[0].rows} row(s); this drill needs a throwaway database`,
        );
      }
    } else {
      await client.query("create schema supabase_migrations");
      await client.query(
        "create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)",
      );
    }

    for (const item of cases) {
      if (item.sql) {
        // A literal, because the value is one no bound parameter can carry. The
        // label and version are still bound; nothing here interpolates input.
        await client.query(
          `insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, ${item.sql}, $2)`,
          [item.version, item.label],
        );
        continue;
      }
      await client.query(
        "insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)",
        [item.version, item.statements, item.label],
      );
    }

    const { rows } = await client.query(HISTORY_QUERY);
    const byVersion = new Map(rows.map((row) => [String(row.version), row]));
    const digests = new Map();
    const superseded = new Map(
      (await client.query(SUPERSEDED_QUERY)).rows.map((row) => [
        String(row.version),
        `${row.statement_count}:${row.statements_sha256}`,
      ]),
    );

    const check = (item) => {
      const row = byVersion.get(item.version);
      if (row === undefined) {
        console.log(`FAIL  ${item.label}: the server did not return the row`);
        return false;
      }
      digests.set(item.label, `${row.statement_count}:${row.statements_sha256}`);

      const serverRefused = row.statement_count === null && row.statements_sha256 === null;

      // Round-4 C4-6, and only in the parity pass: --self-test deliberately runs a
      // wrong JS side and requires every row to be reported as a difference, so the
      // domain expectations below — which report agreement — are not applied there.
      // The plain comparison at the bottom reports those rows as differences, which
      // in that mode is the correct answer for them too.
      if (!selfTest && item.refused === true) {
        // Neither side can honestly fingerprint this value, so both must decline.
        // "One declines" is the drift this harness exists to catch: it is the shape
        // in which a false accusation or a false pass would arrive.
        let reason = null;
        try {
          fingerprint(item.statements);
        } catch (error) {
          if (error.code !== "unfingerprintable_statements") throw error;
          reason = error.reason;
        }
        if (reason !== null && serverRefused) return true;
        console.log(
          `FAIL  ${item.label}: declared outside the fingerprintable domain, but` +
            ` js ${reason === null ? "produced a digest" : `refused (${reason})`} and the server` +
            ` ${serverRefused ? "refused" : `returned count=${row.statement_count}`}`,
        );
        return false;
      }
      if (!selfTest && item.serverOnly === true) {
        // A value PostgreSQL admits and JavaScript cannot represent: `text[]`
        // subscripts start where the value says, and an array with a lower bound
        // other than 1 is a different value from the one JS would build out of the
        // same elements. There is nothing for the JS side to refuse — it is handed
        // the flattened equivalent, which is exactly the collision partner — so the
        // server's refusal is the whole defence, and this is where it is measured.
        if (serverRefused) return true;
        console.log(
          `FAIL  ${item.label}: the server accepted a value JavaScript cannot express` +
            ` (count=${row.statement_count} digest=${String(row.statements_sha256).slice(0, 16)}), so it can be compared with one it can`,
        );
        return false;
      }

      let expected;
      try {
        expected = fingerprint(item.statements);
      } catch (error) {
        if (error.code !== "unfingerprintable_statements") throw error;
        console.log(
          `FAIL  ${item.label}: the js side refused a vector that is not declared outside the domain (${error.reason})`,
        );
        return false;
      }
      const expectedCount = Array.isArray(item.statements) ? item.statements.length : 0;
      const countOk = Number(row.statement_count) === expectedCount;
      const digestOk = row.statements_sha256 === expected;
      if (countOk && digestOk) return true;
      // Digest prefixes only. The point of the whole design is that statement
      // text does not leave the database, and a failure report is not an excuse.
      // In --self-test every row is expected to differ, so the per-row lines are
      // suppressed and only the total is reported.
      if (!selfTest) {
        console.log(
          `FAIL  ${item.label}: count server=${row.statement_count} js=${expectedCount}` +
            ` digest server=${String(row.statements_sha256).slice(0, 16)} js=${expected.slice(0, 16)}`,
        );
      }
      return false;
    };

    for (const item of cases) if (!check(item)) failures += 1;

    for (const [a, b] of MUST_DIFFER) {
      if (digests.get(a) !== undefined && digests.get(a) === digests.get(b)) {
        console.log(`FAIL  ${a} and ${b} share a digest: a moved statement boundary is invisible`);
        failures += 1;
      }
    }

    // Round-4 C4-6, and the negative control for it. Each pair has to collide
    // under the expression this one replaced — otherwise this check is looking for
    // something it could not find, and its silence would mean nothing — and must
    // not collide under the current one.
    const byLabel = new Map(synthetic.map((item) => [item.label, item.version]));
    // A digest neither side produced is not a digest two values share: two refused
    // values are both reported as `null:null`, and reading that as a collision
    // would turn the fix into a failure. The claim is about digests that exist.
    const measured = (label) => (digests.get(label) ?? "").endsWith(":null") === false ? digests.get(label) : undefined;
    let detected = 0;
    for (const [a, b] of MUST_NOT_COLLIDE) {
      const before = superseded.get(byLabel.get(a));
      if (before !== undefined && before === superseded.get(byLabel.get(b))) detected += 1;
      if (measured(a) !== undefined && measured(a) === measured(b)) {
        console.log(`FAIL  ${a} and ${b} share a count and a digest: a value this release cannot produce satisfies a claim about one it can`);
        failures += 1;
      }
    }
    if (detected !== MUST_NOT_COLLIDE.length) {
      console.log(
        `FAIL  the superseded expression collided on ${detected} of ${MUST_NOT_COLLIDE.length} pair(s): this harness cannot demonstrate that it detects a collision, so its verdict on the current one is worth nothing`,
      );
      failures += 1;
    }

    console.log(`mode                : ${selfTest ? "SELF-TEST (JS side deliberately wrong)" : "parity"}`);
    console.log(`format              : ${FINGERPRINT_FORMAT}`);
    console.log(`server              : ${(await client.query("show server_version")).rows[0].server_version}`);
    console.log(`adversarial vectors : ${synthetic.length} compared, ${synthetic.filter((item) => item.refused === true).length} required to be refused by both sides`);
    console.log(`release migrations  : ${fromFiles.length} parsed, recorded and compared`);
    console.log(`boundary pairs      : ${MUST_DIFFER.length} required to differ`);
    console.log(`collision pairs     : ${MUST_NOT_COLLIDE.length} required to differ now and ${detected} measured colliding under the superseded expression`);
  } finally {
    // Always. DDL is transactional in PostgreSQL, so this undoes the schema and
    // the table as well as the rows.
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }

  if (selfTest) {
    // Every row, not merely one: the superseded encoding differs from this one on
    // every array including the empty one, so a harness that reported fewer is
    // silently agreeing somewhere it should not.
    console.log(`differences detected: ${failures} of ${cases.length} row(s)`);
    if (failures !== cases.length) {
      console.error(
        `self-test FAILED: a wholly different encoding produced ${failures} difference(s) on ${cases.length} row(s); this harness cannot be trusted to detect a real one`,
      );
      return 1;
    }
    console.log("statement fingerprint parity self-test OK: the harness reports differences");
    return 0;
  }

  if (failures > 0) {
    console.error(`statement fingerprint parity FAILED: ${failures} difference(s)`);
    return 1;
  }
  console.log("statement fingerprint parity OK");
  return 0;
}

function parseArgs(argv) {
  const options = { selfTest: false };
  for (const arg of argv) {
    if (arg === "--self-test") {
      options.selfTest = true;
      continue;
    }
    throw new Error(
      /postgres(ql)?:\/\//.test(arg) || arg.startsWith("--url")
        ? "the target is read from the PG* environment, never from an argument"
        : `unknown argument: ${arg}`,
    );
  }
  return options;
}

const fail = (error) => {
  console.error(`statements-fingerprint-parity: ${error.message}`);
  process.exit(1);
};

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error);
}

main(options).then((code) => process.exit(code), fail);
