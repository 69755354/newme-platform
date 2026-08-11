/**
 * Fail-closed comparison of a release's migration directory against the history
 * the target database actually recorded.
 *
 * scripts/check-migration-history.mjs proves that applied migrations in THIS
 * REPOSITORY are byte-identical to the base commit and that new ones are
 * forward-only. It cannot know what production ran. The defect that rejected the
 * reviewed revision of this branch — an applied migration renamed, another
 * rewritten — is exactly the class of defect that is invisible from inside the
 * repository once the rewrite has been committed. This script closes that by
 * asking the database.
 *
 * What it reads: supabase_migrations.schema_migrations, inside a READ ONLY
 * transaction. Two columns, version and name. No business table, no auth
 * identity, no row contents.
 *
 * What it never does: print the connection string, accept it as a command-line
 * argument (arguments are world-readable in /proc), or write anything.
 *
 * Usage:
 *   node scripts/verify-remote-migration-history.mjs \
 *     --url-file /etc/newme/migration-db.url \
 *     [--migrations-dir <dir>] [--modules-dir <dir>] \
 *     [--require-applied <ids>] [--require-no-pending]
 *
 * --require-applied <ids>  comma-separated migration ids (full filename stem or
 *                          bare 14-digit version) that MUST be recorded as
 *                          applied. This is the deploy's `applied_verified`
 *                          claim, re-measured.
 * --require-no-pending     refuse if the release contains any migration the
 *                          database has not applied. This is the deploy's
 *                          `not_required` claim, re-measured.
 * --modules-dir <dir>      where to resolve `pg` from, for hosts where the
 *                          release being deployed has no node_modules yet.
 *
 * Exit: 0 only when every check passes. Any problem, any unanswered question and
 * any error exits 1 with the reasons on stderr.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const CLI_MIGRATION = /^([0-9]{14})_(.+)\.sql$/;

/**
 * The set of files the Supabase CLI would actually apply, in the order it would
 * apply them. Anything else in the directory (rollback_*.sql, README) is inert
 * and deliberately not compared.
 */
export function readLocalMigrations(dir) {
  return fs
    .readdirSync(dir)
    .filter((entry) => CLI_MIGRATION.test(entry))
    .sort()
    .map((file) => {
      const [, version, name] = file.match(CLI_MIGRATION);
      return { version, name, file };
    });
}

/** Accept `20260811100300_f02_x` or `20260811100300`; return the version. */
function normalizeId(id) {
  const trimmed = id.trim();
  const match = /^([0-9]{14})(?:_.*)?$/.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * The whole judgement, as a pure function over two lists, so it is testable
 * without a database. Returns a list of problems; empty means OK.
 */
export function compareHistories({
  remote,
  local,
  requireApplied = [],
  requireNoPending = false,
}) {
  const problems = [];

  if (!Array.isArray(remote) || remote.length === 0) {
    problems.push(
      "the database reports zero applied migrations; either this is not the production database or its migration history has been erased",
    );
    return problems;
  }

  const localByVersion = new Map(local.map((entry) => [entry.version, entry]));
  const remoteByVersion = new Map();
  for (const row of remote) {
    const version = typeof row.version === "string" ? row.version : String(row.version ?? "");
    if (!/^[0-9]{14}$/.test(version)) {
      problems.push(`the database records an applied version ${JSON.stringify(version)} that is not a 14-digit CLI stamp`);
      continue;
    }
    if (remoteByVersion.has(version)) {
      problems.push(`the database records version ${version} twice`);
      continue;
    }
    remoteByVersion.set(version, row);
  }

  // 1 · Every version production applied must still be in the release, under the
  //     same name. A missing one was deleted; a differently-named one was
  //     renamed. Both mean the directory no longer describes what ran.
  for (const [version, row] of remoteByVersion) {
    const localEntry = localByVersion.get(version);
    if (!localEntry) {
      problems.push(
        `the database applied ${version} (recorded name: ${row.name ? row.name : "<none>"}) but this release contains no such migration: applied history was deleted or renamed`,
      );
      continue;
    }
    const recorded = typeof row.name === "string" ? row.name.trim() : "";
    if (recorded !== "" && recorded !== localEntry.name) {
      problems.push(
        `the database applied ${version} as ${JSON.stringify(recorded)} but this release calls it ${JSON.stringify(localEntry.name)}: applied history was renamed`,
      );
    }
  }

  // 2 · The claim the deploy made about migrations, re-measured.
  for (const id of requireApplied) {
    const version = normalizeId(id);
    if (!version) {
      problems.push(`${JSON.stringify(id)} is not a migration id this gate can check`);
      continue;
    }
    if (!localByVersion.has(version)) {
      problems.push(`${id} was claimed applied but this release contains no migration ${version}`);
    }
    if (!remoteByVersion.has(version)) {
      problems.push(`${id} was claimed applied but the database has no record of ${version}`);
    }
  }

  // 3 · What the release carries that the database has not run.
  const newestRemote = [...remoteByVersion.keys()].sort().at(-1);
  const pending = local.filter((entry) => !remoteByVersion.has(entry.version));
  for (const entry of pending) {
    if (entry.version <= newestRemote) {
      // Forward-only against the database, not merely against the repository:
      // the CLI orders by filename, so an unapplied migration that sorts before
      // applied history will never be picked up and its absence is permanent.
      problems.push(
        `${entry.file} is not applied and sorts at or before the newest applied version ${newestRemote}: it can never be applied in order`,
      );
    }
  }
  if (requireNoPending && pending.length > 0) {
    problems.push(
      `the release was declared to need no migrations, but ${pending.length} migration(s) in it are not applied: ${pending
        .map((entry) => entry.file)
        .join(", ")}`,
    );
  }

  return problems;
}

function parseArgs(argv) {
  const options = {
    urlFile: null,
    migrationsDir: null,
    modulesDir: null,
    requireApplied: [],
    requireNoPending: false,
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
      case "--url-file":
        options.urlFile = next();
        break;
      case "--migrations-dir":
        options.migrationsDir = next();
        break;
      case "--modules-dir":
        options.modulesDir = next();
        break;
      case "--require-applied":
        options.requireApplied = next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--require-no-pending":
        options.requireNoPending = true;
        break;
      default:
        // Refused rather than ignored, and refused by shape: a connection string
        // on the command line is a credential in /proc and in the shell history
        // of whoever ran it.
        throw new Error(
          arg.startsWith("--url=") || /postgres(ql)?:\/\//.test(arg)
            ? "the connection string must be read from a file, never passed as an argument"
            : `unknown argument: ${arg}`,
        );
    }
  }
  return options;
}

/** Read the URL without letting it reach stdout, stderr, argv or an env var. */
function readUrlFile(file) {
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

function loadPg(modulesDir) {
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

async function fetchRemoteHistory(url, modulesDir) {
  const { Client } = loadPg(modulesDir);
  const client = new Client({
    connectionString: url,
    application_name: "newme-verify-remote-migration-history",
    statement_timeout: 15000,
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
  } catch (error) {
    // Deliberately not error.message: a pg connection error can quote the URL.
    throw new Error(`could not connect to the migration database (${error.code ?? error.name})`);
  }
  try {
    // READ ONLY is not decoration: it is the guarantee that this gate cannot
    // mutate the database it is inspecting, enforced by the server.
    await client.query("begin read only");
    const result = await client.query(
      "select version, name from supabase_migrations.schema_migrations order by version",
    );
    await client.query("commit");
    return result.rows;
  } catch (error) {
    if (error.code === "42P01") {
      throw new Error("the database has no supabase_migrations.schema_migrations table");
    }
    throw new Error(`the migration history query failed (${error.code ?? error.name})`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.urlFile) throw new Error("--url-file is required");

  const migrationsDir =
    options.migrationsDir ??
    path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "supabase", "migrations");
  const local = readLocalMigrations(migrationsDir);
  if (local.length === 0) throw new Error(`no CLI-applicable migrations found in ${migrationsDir}`);

  const remote = await fetchRemoteHistory(readUrlFile(options.urlFile), options.modulesDir);
  const problems = compareHistories({
    remote,
    local,
    requireApplied: options.requireApplied,
    requireNoPending: options.requireNoPending,
  });

  const applied = remote.length;
  const pending = local.length - local.filter((entry) => remote.some((row) => String(row.version) === entry.version)).length;
  console.log(`remote applied      : ${applied}`);
  console.log(`release migrations  : ${local.length}`);
  console.log(`not yet applied     : ${pending}`);
  if (options.requireApplied.length > 0) {
    console.log(`claimed applied     : ${options.requireApplied.length}`);
  }
  if (options.requireNoPending) {
    console.log("claim               : this release needs no migrations");
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`remote migration history: ${problem}`);
    console.error(`refusing: ${problems.length} problem(s)`);
    return 1;
  }
  console.log("OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`remote migration history: ${error.message}`);
      process.exit(1);
    },
  );
}
