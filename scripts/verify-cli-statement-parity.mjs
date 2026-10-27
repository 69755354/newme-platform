/**
 * Measure that splitSqlStatements() produces the array the Supabase CLI records.
 *
 * Round-4 finding C4, second half. The remote-history gate can only claim
 * "production ran this release's SQL" if the local side of the comparison is the
 * same array the tool that applied the SQL wrote down. That array is not a
 * property of the SQL: `supabase db push` / `migration up` / `db reset` read the
 * file, split it with their own lexer, execute the pieces and record the pieces in
 * supabase_migrations.schema_migrations.statements. scripts/split-sql-statements.mjs
 * reproduces that lexer from documented PostgreSQL rules, and this repository
 * does not vendor the CLI's Go source, so the reproduction is a claim about
 * software nobody here can read.
 *
 * This drill turns the claim into a measurement. It writes an adversarial corpus
 * into a scratch project, applies it with the pinned CLI against a throwaway
 * database, reads back the array the CLI recorded, and requires
 * splitSqlStatements() to have produced it element for element, byte for byte.
 *
 * The corpus is chosen for the cases where a plausible splitter goes wrong and
 * the error is invisible: a semicolon inside a comment, a string, a quoted
 * identifier or a dollar-quoted body; a backslash at the end of an ordinary
 * string, which is a complete string under standard_conforming_strings and a
 * swallowed rest-of-file under a lexer that thinks it is an escape; a
 * backslash-escaped quote inside E'', where it really is an escape; nested block
 * comments; nested dollar tags that must match exactly; CRLF; multi-byte text;
 * and the empty statements a trailing `;;` produces.
 *
 * Every corpus file must EXECUTE, because the CLI records what it applied: a file
 * that fails aborts the push and records nothing, and a drill that only proved
 * the CLI rejects bad SQL would prove nothing about splitting. Two cases are
 * therefore deliberately absent and stated rather than smuggled: a leading UTF-8
 * BOM and an unterminated quote or comment, both of which the server rejects, so
 * the splitter's behaviour for them is unmeasured here. The gate that consumes
 * the splitter reports a difference for a file it cannot reproduce, which is the
 * safe direction.
 *
 * Safety. The target is built from the standard PG* environment and must be
 * loopback with no password configured, so no credential is ever placed in a
 * command argument — the CLI needs a URL on its command line, and the only URL
 * this script will ever construct is one to a passwordless local throwaway
 * database. The CLI binary comes from SUPABASE_BIN or PATH; its version is
 * printed, and recorded in the result, because parity is established per CLI
 * version and for no other.
 *
 * Usage (CI, .github/workflows/ci.yml job `local-database`, CLI pinned 2.113.0):
 *   createdb cli_parity
 *   PGDATABASE=cli_parity node scripts/verify-cli-statement-parity.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { splitSqlStatements } from "./split-sql-statements.mjs";

/**
 * One migration file each. `sql` is written verbatim, including the absence of a
 * trailing newline where that is the point.
 */
const CORPUS = [
  {
    name: "two_plain_statements",
    sql: "create table t_plain (id int);\nselect 1;\n",
  },
  {
    name: "empty_statements_and_blank_lines",
    sql: "select 1;;\n\n\nselect 2;\n\n;\n",
  },
  {
    name: "no_trailing_semicolon",
    sql: "select 1;\nselect 2\n",
  },
  {
    name: "semicolon_in_line_comment",
    sql: "-- a comment; with a semicolon\nselect 1;\nselect 2; -- and a trailing one;\n",
  },
  {
    name: "semicolon_in_block_comment",
    sql: "/* block; comment */\nselect 1;\n/* another;\n   spanning lines; */\nselect 2;\n",
  },
  {
    name: "nested_block_comment",
    sql: "/* outer; /* inner; */ still outer; */\nselect 1;\n",
  },
  {
    name: "semicolon_in_string",
    sql: "select 'a;b';\nselect 'c;d';\n",
  },
  {
    name: "doubled_quote_in_string",
    sql: "select 'it''s; fine';\nselect 2;\n",
  },
  {
    name: "escape_string_backslash_quote",
    // The case that made this drill worth writing. PostgreSQL's lexer reads
    // E'a\'b' as the single string a'b; the CLI does not honour the backslash, so
    // it closes at the quote after it, and the quote before `;` then opens a
    // string that runs to end of file. The CLI therefore records ONE statement
    // here where a server-faithful splitter records two — and this file, unlike
    // `E'a\';b';`, still executes, so the difference reaches applied history
    // instead of aborting the push. splitSqlStatements() has to be wrong the same
    // way. If a later CLI fixes its lexer this case turns red, which is correct:
    // parity is per CLI version.
    sql: "select E'a\\'b';\nselect 2;\n",
  },
  {
    name: "standard_string_trailing_backslash",
    // Under standard_conforming_strings (on by default since 9.1) this is the
    // complete two-character string a\ and the semicolon terminates the
    // statement. A lexer that treats the backslash as an escape consumes the
    // closing quote and swallows everything after it.
    sql: "select 'a\\';\nselect 2;\n",
  },
  {
    name: "semicolon_in_quoted_identifier",
    sql: 'create table "t;semi" (id int);\nselect 1;\n',
  },
  {
    name: "doubled_quote_in_identifier",
    sql: 'create table "t""q;uote" (id int);\nselect 1;\n',
  },
  {
    name: "dollar_quoted_body",
    sql: "create function f_dollar() returns int language plpgsql as $$\nbegin\n  perform 1;\n  return 1;\nend\n$$;\nselect f_dollar();\n",
  },
  {
    name: "tagged_dollar_quote_containing_untagged",
    sql: "create function f_tag() returns text language plpgsql as $fn$\nbegin\n  return $$inner; text$$;\nend\n$fn$;\nselect f_tag();\n",
  },
  {
    name: "nested_dollar_tags_exact_match",
    sql: "create function f_nest() returns text language plpgsql as $outer$\nbegin\n  return $inner$ ; not a boundary ; $inner$;\nend\n$outer$;\nselect f_nest();\n",
  },
  {
    name: "dollar_parameter_inside_string_body",
    // $1 is a parameter placeholder, not a dollar-quote opener; a splitter that
    // opened a quote at $1$ would run past the end of the statement.
    sql: "create function f_param(int) returns int language sql as 'select $1';\nselect f_param(1);\n",
  },
  {
    name: "empty_string_and_set",
    sql: "set search_path = '';\nselect pg_catalog.pg_backend_pid() is not null;\n",
  },
  {
    name: "crlf_line_endings",
    sql: "select 1;\r\nselect 2;\r\n",
  },
  {
    name: "multi_byte_text",
    sql: "-- 迁移 · émoji 🚀 ;\nselect '合同; 金额' as note;\nselect 2;\n",
  },
  {
    name: "line_comment_at_eof_without_newline",
    sql: "select 1;\n-- trailing comment without a newline",
  },
  {
    name: "do_block_with_empty_tag",
    sql: "do $$ begin perform 1; end $$;\nselect 1;\n",
  },
];

function loadPg() {
  return createRequire(fileURLToPath(import.meta.url))("pg");
}

/**
 * The connection URL for the CLI, from the environment.
 *
 * The CLI takes a URL on its command line and there is no file-based
 * alternative, so the only URL this builds is one that cannot carry a secret: a
 * loopback host, no password, and a refusal if the environment says otherwise.
 */
function targetUrl() {
  const host = (process.env.PGHOST ?? "127.0.0.1").trim();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local) {
    throw new Error(
      `refusing to run against PGHOST=${host}: this drill applies migrations and only runs against a loopback throwaway database`,
    );
  }
  if (process.env.PGPASSWORD || process.env.PGPASSFILE) {
    throw new Error(
      "refusing: a password is configured for this target. The CLI needs the URL as an argument, and this drill will not put a credential in one.",
    );
  }
  const port = (process.env.PGPORT ?? "5432").trim();
  const user = (process.env.PGUSER ?? "postgres").trim();
  const database = (process.env.PGDATABASE ?? user).trim();
  for (const [label, value] of [["PGUSER", user], ["PGDATABASE", database]]) {
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
      throw new Error(`refusing: ${label}=${value} is not a plain identifier`);
    }
  }
  if (!/^[0-9]+$/.test(port)) throw new Error(`refusing: PGPORT=${port} is not a port number`);
  const bracketed = host === "::1" ? "[::1]" : host;
  // sslmode=disable is required because the CLI otherwise demands TLS, and a
  // throwaway trust-auth container does not offer it. It is safe here for the
  // same reason the URL is safe on a command line at all: the host is loopback by
  // the check above, there is no password by the check above, and the database is
  // created and destroyed by the drill. Nothing confidential traverses the socket.
  return `postgresql://${user}@${bracketed}:${port}/${database}?sslmode=disable`;
}

/** A scratch Supabase project holding the corpus, one file per case. */
function writeProject(root) {
  const supabaseDir = path.join(root, "supabase");
  const migrationsDir = path.join(supabaseDir, "migrations");
  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.writeFileSync(path.join(supabaseDir, "config.toml"), 'project_id = "newme-cli-statement-parity"\n');
  const written = [];
  for (const [index, entry] of CORPUS.entries()) {
    const version = `2099010100${String(index + 1).padStart(4, "0")}`;
    const file = `${version}_${entry.name}.sql`;
    // Written as bytes, so a case whose point is a CRLF or a missing final
    // newline reaches the CLI exactly as authored.
    fs.writeFileSync(path.join(migrationsDir, file), Buffer.from(entry.sql, "utf8"));
    written.push({ ...entry, version, file });
  }
  return { root, migrationsDir, written };
}

/** A one-line, whitespace-visible excerpt. The corpus is authored in this file. */
const excerpt = (value, limit = 72) => {
  const shown = String(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return shown.length > limit ? `${shown.slice(0, limit)}…` : shown;
};

async function main() {
  const url = targetUrl();
  const cli = process.env.SUPABASE_BIN || "supabase";

  let version;
  try {
    version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`the Supabase CLI could not be run (${cli}: ${error.code ?? error.message})`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newme-cli-parity-"));
  let applied;
  try {
    const project = writeProject(root);
    console.log(`cli                 : ${version}`);
    console.log(`corpus              : ${project.written.length} migration file(s)`);

    try {
      execFileSync(cli, ["migration", "up", "--db-url", url, "--workdir", root, "--include-all", "--yes"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      });
    } catch (error) {
      const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
      throw new Error(
        `the CLI could not apply the corpus, so it recorded nothing to compare against:\n${detail || error.message}`,
      );
    }
    applied = project.written;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const { Client } = loadPg();
  const client = new Client({
    connectionString: url,
    application_name: "newme-verify-cli-statement-parity",
    statement_timeout: 30000,
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  let recorded;
  try {
    recorded = (
      await client.query(
        "select version, name, statements from supabase_migrations.schema_migrations order by version",
      )
    ).rows;
  } finally {
    await client.end().catch(() => {});
  }

  const byVersion = new Map(recorded.map((row) => [String(row.version), row]));
  let failures = 0;

  for (const entry of applied) {
    const row = byVersion.get(entry.version);
    if (row === undefined) {
      console.log(`FAIL  ${entry.name}: the CLI recorded no row for ${entry.version}`);
      failures += 1;
      continue;
    }
    if (!Array.isArray(row.statements)) {
      console.log(
        `FAIL  ${entry.name}: the CLI recorded no statements array (${row.statements === null ? "null" : typeof row.statements})`,
      );
      failures += 1;
      continue;
    }
    const mine = splitSqlStatements(entry.sql);
    const theirs = row.statements;
    if (mine.length !== theirs.length) {
      console.log(`FAIL  ${entry.name}: ${mine.length} statement(s) split, ${theirs.length} recorded`);
      for (let i = 0; i < Math.max(mine.length, theirs.length); i += 1) {
        console.log(`        [${i}] cli=${excerpt(theirs[i] ?? "<none>")}`);
        console.log(`        [${i}] ours=${excerpt(mine[i] ?? "<none>")}`);
      }
      failures += 1;
      continue;
    }
    let mismatch = -1;
    for (let i = 0; i < mine.length; i += 1) {
      if (!Buffer.from(mine[i], "utf8").equals(Buffer.from(String(theirs[i] ?? ""), "utf8"))) {
        mismatch = i;
        break;
      }
    }
    if (mismatch >= 0) {
      console.log(`FAIL  ${entry.name}: statement ${mismatch} differs`);
      console.log(`        cli =${excerpt(theirs[mismatch])}`);
      console.log(`        ours=${excerpt(mine[mismatch])}`);
      failures += 1;
      continue;
    }
    console.log(`ok    ${entry.name} (${mine.length} statement(s))`);
  }

  const extra = recorded.filter((row) => !applied.some((entry) => entry.version === String(row.version)));
  if (extra.length > 0) {
    console.log(`FAIL  the database recorded ${extra.length} row(s) this drill did not apply`);
    failures += 1;
  }

  console.log(`recorded rows       : ${recorded.length}`);
  console.log(`compared            : ${applied.length}`);

  if (failures > 0) {
    console.error(
      `CLI statement parity FAILED for ${version}: ${failures} case(s). scripts/split-sql-statements.mjs does not reproduce this CLI, so the remote-history content proof cannot use it.`,
    );
    return 1;
  }
  console.log(`CLI statement parity OK: splitSqlStatements() reproduces ${version} on ${applied.length} adversarial case(s)`);
  return 0;
}

if (process.argv.length > 2) {
  console.error(
    "verify-cli-statement-parity: this drill takes no arguments; the target comes from PG* and the binary from SUPABASE_BIN",
  );
  process.exit(1);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`verify-cli-statement-parity: ${error.message}`);
    process.exit(1);
  },
);
