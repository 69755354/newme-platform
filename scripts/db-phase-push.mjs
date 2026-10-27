#!/usr/bin/env node
/**
 * Exact-hash phase applier — one release phase, from this exact tree.
 * ============================================================================
 * `supabase db push` applies every pending migration in one run. This release
 * must not be applied that way: the expand phase (`required_for_app`) has to be
 * live while the PREVIOUS release is still deployed, and the contract phase
 * (`deferred_contract`) closes the rollback boundary and may only be applied
 * after the candidate is deployed and verified. See
 * supabase/preflight/expand-contract-rollback.md.
 *
 * Round-4 review C7: "the documented two-phase `db push` is not executable from
 * the exact tree … provide and test an exact-hash phase tool that records correct
 * migration history. Do not temporarily remove files or rewrite history." This is
 * that tool. It moves no file, edits no file, and rewrites no history: it applies
 * the files one named phase of infra/release/release-manifest.json lists, after
 * checking each file's SHA-256 against the manifest, and records each one in
 * supabase_migrations.schema_migrations in the same shape the CLI records.
 *
 * What it refuses, before touching anything:
 *   * a manifest that does not match the tree (scripts/check-release-manifest.mjs
 *     runs first, in-process, and its refusals are this tool's refusals)
 *   * a file whose content hash is not the manifest's hash
 *   * `deferred_contract` while any `required_for_app` migration is unapplied —
 *     C6's "required migrations are applied", enforced rather than claimed
 *   * `required_for_app` when the contract phase is already recorded, which would
 *     mean the window was closed before it was opened
 *   * a version already recorded under a different name, a duplicate version, or
 *     a file that sorts at or before the newest recorded version and so could
 *     never be applied in order
 *   * a database with no supabase_migrations.schema_migrations (production has
 *     one; a fresh database needs --init-history, which is what the replay
 *     harness passes)
 *
 * How it applies: one transaction per migration, containing the migration's SQL
 * and its history row. A failure rolls back that migration and stops the run, so
 * the recorded history is always exactly the set that succeeded — never a row for
 * SQL that did not run, never SQL that ran without a row. The file's own `begin;`
 * / `commit;` is skipped rather than sent (see isTransactionControl), because an
 * inner `commit` would end this tool's transaction and break exactly that
 * property; a statement that cannot run inside a transaction block at all, and any
 * other statement that would end, hand away or partly discard the transaction —
 * `rollback`, `abort`, `savepoint`, `release`, `and chain`, `prepare transaction`,
 * `set transaction`, `discard` (see breaksOuterTransaction) — is a refusal for the
 * whole phase before anything is applied.
 *
 * After applying it verifies, in a READ ONLY transaction:
 *   * read-after-write on the history itself: every row it just wrote is read
 *     back and its recorded content is fingerprinted server-side and compared
 *     with the local file's statements. A history row that does not describe the
 *     file that produced it is a failure of this run, not a later surprise.
 *   * the phase's runtime posture predicates from the manifest, which are
 *     single read-only selects with a declared boolean result.
 *
 * Secrets: the connection URL is read from a file, never accepted as an argument
 * and never printed. No row contents, no statement text and no error detail from
 * the server are printed — only version, name, byte and statement counts, hash
 * prefixes, SQLSTATE and the message of a refusal this tool raised itself.
 *
 * Usage:
 *   node scripts/db-phase-push.mjs --phase required_for_app --url-file FILE --plan
 *   node scripts/db-phase-push.mjs --phase required_for_app --url-file FILE --apply
 *   node scripts/db-phase-push.mjs --phase deferred_contract --url-file FILE --verify-only
 *   node scripts/db-phase-push.mjs --phase required_for_app --url-file FILE --verify-recorded-posture
 *
 * --plan (default) reports what would be applied and runs every precondition,
 * including the hash check, without writing. --apply writes. --verify-only skips
 * applying and checks the phase's history and posture as it stands, including
 * normal phase ordering. --verify-recorded-posture is the recovery-only read
 * path: it requires every selected-phase row to be recorded under its exact name
 * and verifies content plus posture, but does not reject merely because a later
 * phase is also recorded. It never writes and cannot initialize history.
 *
 * Exit 0 only when everything asked for passed.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  MANIFEST_PATH,
  PHASES,
  ROOT,
  auditManifest,
  contentHash,
  manifestEntries,
  readBaseline,
  readManifest,
  readMigration,
  readTreeFiles,
} from "./check-release-manifest.mjs";
import { splitSqlStatements } from "./split-sql-statements.mjs";
import {
  STATEMENTS_FINGERPRINT_SQL,
  statementsFingerprint,
} from "./verify-remote-migration-history.mjs";

const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const CLI_MIGRATION = /^([0-9]{14})_(.+)\.sql$/;

/** A statement's SQL with comments removed, lowercased — for classification only. */
export function statementCode(statement) {
  return String(statement)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Transaction control the migration writes for itself.
 *
 * Every migration in this release opens `begin;` and closes `commit;`, because
 * each is meant to be all-or-nothing on its own. Sent as written inside this
 * tool's own transaction, the file's `commit` would commit THAT transaction and
 * the history row would then be written outside it — a migration could be applied
 * with no history row, or a history row could fail with the migration already
 * committed. So the file's own transaction control is skipped and the tool's
 * single transaction is the one that commits: the migration and its history row,
 * together or not at all.
 */
const OWN_TRANSACTION_CONTROL = /^(?:begin|start transaction|commit|end)(?: work| transaction)?$/;

export function isTransactionControl(statement) {
  return OWN_TRANSACTION_CONTROL.test(statementCode(statement));
}

/**
 * The leading keywords of every statement that changes transaction state.
 *
 * Round-4 C4-6. `isTransactionControl` above is an allowlist of the two forms
 * this tool skips, and everything it does not match used to be executed — which
 * is fine for `create table` and catastrophic for the rest of this vocabulary,
 * because the transaction it would end is the one carrying the migration and its
 * history row together:
 *
 *   rollback, abort                 discard the migration, then leave the
 *                                   remaining statements running in autocommit —
 *                                   each committing on its own, and the history
 *                                   row committing too, so the row would claim a
 *                                   migration that was rolled back
 *   savepoint, release, rollback to  discard part of it, silently, and the
 *                                   history row would still be written and
 *                                   committed as if the whole file had run
 *   commit/rollback/end and chain    commit here and open a new transaction, so
 *                                   the history row lands in a different one
 *   prepare transaction              hand the transaction to two-phase commit and
 *                                   dissociate it from this session, leaving the
 *                                   history row to commit separately and a
 *                                   prepared transaction holding locks
 *   commit/rollback prepared         cannot run inside a transaction block at all
 *   set transaction, set constraints,
 *   set session characteristics      change the transaction this tool opened —
 *                                   `set transaction read only` would fail every
 *                                   statement after it
 *   discard                          cannot run inside a transaction block
 *
 * The list of ways to break an outer transaction is longer than the list of ways
 * to open one and grows with each PostgreSQL release, so the shape is an
 * allowlist: a statement whose first keyword is in this vocabulary is refused
 * unless it is exactly one of the two skippable forms. Classification is on
 * `statementCode`, which strips comments; a keyword inside a string literal is
 * not at the start of a statement, and a statement this misreads is refused
 * rather than run.
 */
const TRANSACTION_VOCABULARY =
  /^(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare transaction|discard)\b|^set (?:transaction|constraints|session characteristics)\b/;

/**
 * The transaction-control keyword a statement would execute, or null if it is
 * either ordinary SQL or the file's own outer `begin`/`commit`. Never the
 * statement text: the caller prints what this returns.
 */
export function breaksOuterTransaction(statement) {
  const code = statementCode(statement);
  if (OWN_TRANSACTION_CONTROL.test(code)) return null;
  const match = TRANSACTION_VOCABULARY.exec(code);
  return match ? match[0] : null;
}

/**
 * Statements PostgreSQL refuses to run inside a transaction block. None exist in
 * this release; a file that grows one must not be applied by this tool, because
 * the atomicity above would silently stop being true. Refused by shape, before
 * anything is applied.
 */
export function nonTransactional(statement) {
  return /\b(concurrently|vacuum|create database|drop database|alter system|reindex database)\b/.test(
    statementCode(statement),
  );
}

/**
 * Server-side count and fingerprint of the recorded statements. No text.
 *
 * The digest expression is imported, not written here. This query and the one the
 * remote-history gate runs against production have to ask for the same bytes: the
 * rows this tool writes are the rows that gate later has to reproduce from these
 * same files, and a private encoding here would have made that impossible in a way
 * neither side could see. This tool did carry one — the superseded space-joined
 * form, under a comment claiming it could not collide.
 */
export const HISTORY_CONTENT_QUERY = `select m.version,
       m.name,
       coalesce(array_length(m.statements, 1), 0) as statement_count,
       ${STATEMENTS_FINGERPRINT_SQL} as statements_sha256
  from supabase_migrations.schema_migrations m
 where m.version = any($1::text[])
 order by m.version`;

const HISTORY_LIST_QUERY =
  "select version, name from supabase_migrations.schema_migrations order by version";

/**
 * The preconditions, as a pure function over the manifest and the recorded
 * history. Returns { problems, toApply, alreadyApplied }.
 */
export function planPhase({ manifest, phase, recorded }) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const recordedByVersion = new Map(
    (recorded ?? []).map((row) => [String(row.version), String(row.name ?? "").trim()]),
  );

  const entries = manifestEntries(manifest, phase);
  const other = PHASES.filter((name) => name !== phase).flatMap((name) => manifestEntries(manifest, name));

  // Phase order. Both directions, because both mistakes are possible and only
  // one of them is recoverable.
  if (phase === "deferred_contract") {
    const missing = other.filter((entry) => !recordedByVersion.has(String(entry.version)));
    if (missing.length > 0) {
      fail(
        `the contract phase may not be applied while ${missing.length} required_for_app migration(s) are unapplied: ${missing
          .map((entry) => entry.file)
          .join(", ")}`,
      );
    }
  } else {
    const early = other.filter((entry) => recordedByVersion.has(String(entry.version)));
    if (early.length > 0) {
      fail(
        `the database already records the contract phase (${early
          .map((entry) => entry.version)
          .join(", ")}): the compatibility window is already closed, so this expand push is not the procedure's step 2`,
      );
    }
  }

  const newestRecorded = [...recordedByVersion.keys()].sort().at(-1);
  const toApply = [];
  const alreadyApplied = [];
  for (const entry of entries) {
    const version = String(entry.version);
    const file = String(entry.file);
    const expectedName = CLI_MIGRATION.exec(file)?.[2] ?? "";
    if (recordedByVersion.has(version)) {
      const recordedName = recordedByVersion.get(version);
      if (recordedName !== "" && recordedName !== expectedName) {
        fail(
          `the database records ${version} as ${JSON.stringify(recordedName)} but this release calls it ${JSON.stringify(expectedName)}`,
        );
      }
      alreadyApplied.push(entry);
      continue;
    }
    if (newestRecorded !== undefined && version <= newestRecorded) {
      fail(
        `${file} is unapplied and sorts at or before the newest recorded version ${newestRecorded}: applying it now records history out of order`,
      );
      continue;
    }
    toApply.push(entry);
  }
  return { problems, toApply, alreadyApplied };
}

/**
 * Read-only recovery verification for a phase whose later phase is already in
 * history. Unlike planPhase this is not an application plan: every selected row
 * must already exist under its exact name, and no missing row is returned as
 * work to apply. The content and posture checks still run in main().
 */
export function planRecordedPhase({ manifest, phase, recorded }) {
  const problems = [];
  const recordedByVersion = new Map(
    (recorded ?? []).map((row) => [String(row.version), String(row.name ?? "").trim()]),
  );
  const alreadyApplied = [];
  for (const entry of manifestEntries(manifest, phase)) {
    const version = String(entry.version);
    const expectedName = CLI_MIGRATION.exec(String(entry.file))?.[2] ?? "";
    if (!recordedByVersion.has(version)) {
      problems.push(`${entry.file} is not recorded; recovery verification never applies missing migrations`);
      continue;
    }
    const recordedName = recordedByVersion.get(version);
    if (recordedName !== "" && recordedName !== expectedName) {
      problems.push(
        `the database records ${version} as ${JSON.stringify(recordedName)} but this release calls it ${JSON.stringify(expectedName)}`,
      );
      continue;
    }
    alreadyApplied.push(entry);
  }
  return { problems, toApply: [], alreadyApplied };
}

// --- arguments -------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    phase: null,
    urlFile: null,
    manifest: MANIFEST_PATH,
    modulesDir: null,
    mode: "plan",
    initHistory: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--phase":
        options.phase = next();
        break;
      case "--url-file":
        options.urlFile = next();
        if (/^postgres(ql)?:\/\//.test(options.urlFile)) {
          throw new Error("the connection string must be read from a file, never passed as an argument");
        }
        break;
      case "--manifest":
        options.manifest = next();
        break;
      case "--modules-dir":
        options.modulesDir = next();
        break;
      case "--plan":
        options.mode = "plan";
        break;
      case "--apply":
        options.mode = "apply";
        break;
      case "--verify-only":
        options.mode = "verify";
        break;
      case "--verify-recorded-posture":
        options.mode = "verify-recorded";
        break;
      case "--init-history":
        options.initHistory = true;
        break;
      default:
        throw new Error(
          arg.startsWith("--url=") || /postgres(ql)?:\/\//.test(arg)
            ? "the connection string must be read from a file, never passed as an argument"
            : `unknown argument: ${arg}`,
        );
    }
  }
  if (!PHASES.includes(options.phase)) {
    throw new Error(`--phase must be one of ${PHASES.join(", ")}`);
  }
  if (!options.urlFile) throw new Error("--url-file is required");
  if (options.mode === "verify-recorded" && options.initHistory) {
    throw new Error("--verify-recorded-posture cannot initialize migration history");
  }
  return options;
}

/** Read the URL without letting it reach stdout, stderr, argv or an env var. */
export function readUrlFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("the connection URL file is a symlink");
  if (!stat.isFile()) throw new Error("the connection URL file is not a regular file");
  if (process.getuid && (stat.mode & 0o077) !== 0) {
    throw new Error("the connection URL file is group- or world-accessible");
  }
  const value = fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim();
  if (!/^postgres(ql)?:\/\//.test(value)) {
    throw new Error("the connection URL file does not contain a postgres:// URL");
  }
  return value;
}

export function loadPg(modulesDir) {
  const here = fileURLToPath(import.meta.url);
  const candidates = [];
  if (modulesDir) candidates.push(path.join(modulesDir, "__resolve__.cjs"));
  candidates.push(here);
  const failures = [];
  for (const from of candidates) {
    try {
      return createRequire(from)("pg");
    } catch (error) {
      failures.push(`${from}: ${error.code ?? error.name}`);
    }
  }
  throw new Error(`the pg client could not be resolved (${failures.join("; ")})`);
}

// --- the run ---------------------------------------------------------------

async function main(argv) {
  const options = parseArgs(argv);
  const manifest = readManifest(options.manifest);

  // 1 · The manifest must describe this tree before it is allowed to describe a
  //     production action. These are the same checks CI runs.
  //     readTreeFiles, not a CLI-only readdir: rule 8 compares the declared
  //     companion set against the files it is given, so a caller that filtered the
  //     hand-run files out would invert the rule into "the manifest lists
  //     companions that are not on disk" and refuse every push.
  const { files, hashes } = readTreeFiles(MIGRATIONS_DIR);
  const manifestProblems = auditManifest({ manifest, files, hashes, baseline: readBaseline() });
  if (manifestProblems.length > 0) {
    for (const problem of manifestProblems) console.error(`release manifest: ${problem}`);
    console.error("refusing: the release manifest does not describe this tree");
    return 1;
  }

  // 2 · Content, per file of this phase. Read once, hashed, and that exact text
  //     is what is executed.
  const phaseEntries = manifestEntries(manifest, options.phase);
  const sqlByFile = new Map();
  for (const entry of phaseEntries) {
    const file = String(entry.file);
    const sql = readMigration(MIGRATIONS_DIR, file);
    const hash = contentHash(sql);
    if (hash !== entry.sha256) {
      console.error(`refusing: ${file} does not match the manifest hash`);
      return 1;
    }
    sqlByFile.set(file, sql);
  }

  console.log(`release             : ${manifest.release}`);
  console.log(`phase               : ${options.phase}`);
  console.log(`mode                : ${options.mode}`);
  console.log(`phase migrations    : ${phaseEntries.length} (hashes verified against the manifest)`);

  const { Client } = loadPg(options.modulesDir);
  const client = new Client({
    connectionString: readUrlFile(options.urlFile),
    application_name: `newme-db-phase-push-${options.phase}`,
    connectionTimeoutMillis: 20000,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`could not connect to the migration database (${error.code ?? error.name})`);
  }

  let failures = 0;
  try {
    // 3 · The recorded history.
    let recorded;
    try {
      recorded = (await client.query(HISTORY_LIST_QUERY)).rows;
    } catch (error) {
      if (error.code !== "42P01") throw new Error(`the migration history query failed (${error.code})`);
      if (!options.initHistory) {
        console.error(
          "refusing: the database has no supabase_migrations.schema_migrations. Production has one; pass --init-history only for a fresh database.",
        );
        return 1;
      }
      if (options.mode !== "apply") {
        console.error("refusing: --init-history has nothing to do outside --apply");
        return 1;
      }
      await client.query("create schema if not exists supabase_migrations");
      await client.query(
        "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)",
      );
      console.log("history table       : created (fresh database, --init-history)");
      recorded = [];
    }
    console.log(`recorded versions   : ${recorded.length}`);

    // 4 · The preconditions.
    const { problems, toApply, alreadyApplied } = (options.mode === "verify-recorded" ? planRecordedPhase : planPhase)({
      manifest,
      phase: options.phase,
      recorded,
    });
    console.log(`already applied     : ${alreadyApplied.length}`);
    console.log(`to apply            : ${toApply.length}`);
    for (const entry of toApply) console.log(`  + ${entry.file}`);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`phase: ${problem}`);
      console.error(`refusing: ${problems.length} precondition(s) failed`);
      return 1;
    }

    if (options.mode === "plan") {
      console.log("plan only           : nothing was written");
      return 0;
    }

    // 5 · Apply. One transaction per migration: the SQL and its history row
    //     commit together or not at all.
    if (options.mode === "apply") {
      // Shape refusals for the whole phase first: nothing is applied if any file
      // of it could not be applied atomically.
      for (const entry of toApply) {
        const statements = splitSqlStatements(sqlByFile.get(String(entry.file)));
        const offending = statements.findIndex(nonTransactional);
        if (offending >= 0) {
          console.error(
            `refusing: ${entry.file} statement ${offending + 1} cannot run inside a transaction block, so this tool cannot apply the file atomically`,
          );
          return 1;
        }
        const breaking = statements.findIndex((statement) => breaksOuterTransaction(statement) !== null);
        if (breaking >= 0) {
          console.error(
            `refusing: ${entry.file} statement ${breaking + 1} is transaction control this tool cannot honour (${breaksOuterTransaction(statements[breaking])}): it would end, hand away or partly discard the transaction that carries this migration and its history row together`,
          );
          return 1;
        }
      }

      for (const entry of toApply) {
        const file = String(entry.file);
        const sql = sqlByFile.get(file);
        const statements = splitSqlStatements(sql);
        const name = CLI_MIGRATION.exec(file)[2];
        let executed = 0;
        try {
          await client.query("begin");
          for (const statement of statements) {
            if (isTransactionControl(statement)) continue;
            // The shape refusal above already rejected the whole phase for this,
            // and it is checked again here on purpose: this is the line that
            // would send it, so this is where the guarantee has to hold. A future
            // caller that reaches the apply loop by another route cannot cross it.
            const breaks = breaksOuterTransaction(statement);
            if (breaks !== null) {
              throw Object.assign(new Error(`transaction control reached the apply loop (${breaks})`), {
                code: "transaction_control_in_apply",
              });
            }
            await client.query(statement);
            executed += 1;
          }
          // Recorded as the file's own statements, transaction control included,
          // so the history describes the file rather than this tool's execution.
          await client.query(
            "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
            [String(entry.version), name, statements],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => {});
          // SQLSTATE, the failing file and the statement index — never the
          // server's message, which can quote a row, and never the statement text.
          console.error(
            `refusing: ${file} failed at statement ${executed + 1} of ${statements.length} (SQLSTATE ${error.code ?? "unknown"}) and was rolled back; no history row was written`,
          );
          return 1;
        }
        console.log(
          `applied             : ${entry.version} ${name} (${sql.length} bytes, ${statements.length} statements, ${executed} executed, sha256 ${entry.sha256.slice(0, 12)}…)`,
        );
      }
    }

    // 6 · Read-after-write and posture, read-only.
    await client.query("begin read only");
    const versions = phaseEntries.map((entry) => String(entry.version));
    const content = (await client.query(HISTORY_CONTENT_QUERY, [versions])).rows;
    const contentByVersion = new Map(content.map((row) => [String(row.version), row]));
    for (const entry of phaseEntries) {
      const version = String(entry.version);
      const row = contentByVersion.get(version);
      if (!row) {
        console.error(`history: ${version} is not recorded after this run`);
        failures += 1;
        continue;
      }
      const expected = splitSqlStatements(sqlByFile.get(String(entry.file)));
      let expectedFingerprint;
      try {
        expectedFingerprint = statementsFingerprint(expected);
      } catch (error) {
        if (error.code !== "unfingerprintable_statements") throw error;
        // Round-4 C4-6. Not reachable for a file this release ships (measured: 0 of
        // 120 parse to an empty or missing statement), and if it ever is, the run is
        // over: read-after-write is the only proof this tool offers that the row it
        // wrote describes the file, and a file with no fingerprint cannot supply it.
        console.error(`history: ${version} could not be fingerprinted from ${entry.file} (${error.reason})`);
        failures += 1;
        continue;
      }
      if (row.statement_count === null || row.statements_sha256 === null) {
        // The server refuses to fingerprint a recorded value that is not a
        // one-dimensional array of non-empty text starting at subscript 1. This
        // tool inserts exactly that shape, so a null here means the row it read
        // back is not the row it wrote.
        console.error(
          `history: ${version} is recorded with a value the server cannot fingerprint, so this run cannot prove what it wrote`,
        );
        failures += 1;
        continue;
      }
      const measured = Number(row.statement_count);
      if (measured !== expected.length) {
        console.error(
          `history: ${version} is recorded with ${measured} statement(s), the file has ${expected.length}`,
        );
        failures += 1;
      } else if (row.statements_sha256 !== expectedFingerprint) {
        // Not reachable for a row of this run: the same splitter produced the array
        // that was inserted and the array compared here, and the digest expression
        // is the gate's own. So the row was recorded from bytes this file no longer
        // holds — another tool applied it, the file changed after it was applied, or
        // this checkout's line endings are not the ones that were applied. Reported
        // as unproven content rather than as a mismatch anyone has explained.
        console.error(
          `history: ${version} is recorded with content this release cannot reproduce (fingerprint ${String(row.statements_sha256).slice(0, 12)}… vs ${expectedFingerprint.slice(0, 12)}…): it was not recorded from this file`,
        );
        failures += 1;
      } else {
        console.log(`history verified    : ${version} ${row.name} (${measured} statements, content matches the file)`);
      }
    }

    const predicates = manifest.posture?.[options.phase]?.predicates ?? [];
    const postureApplies = options.mode === "apply" || options.mode === "verify" || options.mode === "verify-recorded";
    if (postureApplies) {
      for (const predicate of predicates) {
        let value;
        try {
          value = (await client.query(predicate.sql)).rows[0];
        } catch (error) {
          console.error(`posture: ${predicate.name} could not be evaluated (SQLSTATE ${error.code ?? "unknown"})`);
          failures += 1;
          continue;
        }
        const actual = value ? Object.values(value)[0] : null;
        if (actual === predicate.expect) {
          console.log(`posture OK          : ${predicate.name}`);
        } else {
          console.error(
            `posture: ${predicate.name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(predicate.expect)}`,
          );
          failures += 1;
        }
      }
    }
    await client.query("commit");
  } finally {
    await client.end().catch(() => {});
  }

  if (failures > 0) {
    console.error(`refusing: ${failures} verification failure(s) after the phase ran`);
    return 1;
  }
  console.log("OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`db phase push: ${error.message}`);
      process.exit(1);
    },
  );
}
