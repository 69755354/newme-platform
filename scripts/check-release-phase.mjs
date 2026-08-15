#!/usr/bin/env node
/**
 * Database phase ↔ release coupling gate.
 * ============================================================================
 * Round-4 review C8: "database phase rollback is not coupled to production app
 * rollback — app rollback does not verify/switch DB mode; contract history can say
 * applied while mode is compat. Required closure: a durable phase state machine.
 * Rollback must verify compat before switching to f37; candidate completion must
 * require strict."
 *
 * This release changes the database in two phases and the schema alone does not say
 * which application code may run against it. The deciding fact is the *mode*:
 * `public.money_direct_write_mode()` returns `compat` while the previous release's
 * direct money writes are still accepted, and `strict` once the contract phase has
 * closed them. See supabase/preflight/expand-contract-rollback.md §2 for the state
 * table this implements:
 *
 *   * the previous release works while the mode is `compat`, or while the mode
 *     function does not exist at all (state 1, before the expand phase)
 *   * the previous release is BROKEN under `strict` — every direct money write it
 *     makes is refused, which is a live outage produced by a rollback that only
 *     moved a symlink
 *   * the candidate works under `compat` and `strict`, and not under `absent`
 *
 * So "which releases may run right now" is a property of the database, and every
 * release has to declare where it can run. A release declares that in its own tree,
 * in infra/release/release-manifest.json:
 *
 *   "runs_under": { "database_phases": ["compat", "strict"] }
 *
 * A release that predates this mechanism carries no declaration, and the honest
 * reading of that is not "anything goes" but the pre-mechanism contract: it runs
 * under `compat` and under `absent`, and not under `strict`. That default is what
 * makes the check meaningful for the rollback this finding is about — the target is
 * the release that has no declaration.
 *
 * Two verdicts, both fail-closed:
 *
 *   --for-switch --release-dir DIR
 *       May the release in DIR serve traffic against the database as it now is?
 *       Used by infra/systemd/newme-production-rollback.sh before it moves the
 *       `current` symlink, and by any path that switches releases. Refusing here is
 *       the point: the operator is told to run the compat companion first
 *       (supabase/migrations/rollback_money_direct_write_contract_phase.sql, §5.1
 *       of the runbook) and to re-run the rollback, rather than discovering the
 *       incompatibility from production traffic.
 *
 *   --for-completion
 *       May the candidate be declared complete? Only under `strict`: completion is
 *       the claim that the release is fully live, and while the mode is `compat` the
 *       contract phase has not closed the direct-write path — the deferred half of
 *       the release is not deployed, whatever the migration history says. This is
 *       the other half of C8's "contract history can say applied while mode is
 *       compat": history records that the file ran, the mode records what it did,
 *       and only the second one can be undone by the companion.
 *
 * Exit 0 means the verdict is yes. Anything else — no, unreadable, unresolvable,
 * malformed declaration, a mode nobody has declared — is a non-zero exit.
 *
 * On success stdout carries exactly one line, `NEWME_DB_PHASE=<mode>`, so a caller
 * can record the observed mode durably; everything else goes to stderr. Nothing is
 * printed but the mode, the target's declaration, and the file the declaration came
 * from: no rows, no identities, no connection string.
 *
 *   node scripts/check-release-phase.mjs --for-switch \
 *     --release-dir /opt/newme/releases/<sha> --url-file /etc/newme/migration-db.url
 *   node scripts/check-release-phase.mjs --for-completion \
 *     --url-file /etc/newme/migration-db.url --modules-dir /opt/newme/current/node_modules
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The URL file's safety checks (symlink, regular file, group/world mode, and the
// refusal to accept anything that is not a postgres:// URL) and the pg resolution
// order are imported rather than restated: they are the rules that keep a
// connection string out of an argument list, and a second implementation of them
// would be a second set of rules that nobody diffed.
import { loadPg, readUrlFile } from "./verify-remote-migration-history.mjs";

/** Every mode this repository knows how to reason about. */
export const KNOWN_PHASES = ["absent", "compat", "strict"];

/**
 * What a release with no declaration runs under.
 *
 * Not a guess: the releases without a declaration are the ones that predate the
 * mode, and they were written against a database where direct money writes were
 * accepted. `compat` reproduces that, `absent` is that, and `strict` is the state
 * that breaks them. Defaulting to the full set instead would make the rollback this
 * gate exists for pass by default.
 */
export const UNDECLARED_PHASES = ["absent", "compat"];

/** Completion is only true under strict; see the header. */
export const COMPLETION_PHASE = "strict";

/**
 * The phases a release declares it runs under, as a pure function over the parsed
 * manifest. Returns { phases, source, problems }.
 *
 * `source` is "declared" or "undeclared", and it is reported rather than inferred
 * by the caller, because "this release said compat" and "nobody asked this release
 * anything" are different pieces of evidence for the same conclusion.
 */
export function resolveDeclaredPhases(manifest) {
  const problems = [];
  if (manifest === null || manifest === undefined) {
    return { phases: UNDECLARED_PHASES, source: "undeclared", problems };
  }
  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    problems.push("the release manifest is not a JSON object");
    return { phases: [], source: "invalid", problems };
  }
  const declared = manifest.runs_under;
  if (declared === undefined) {
    return { phases: UNDECLARED_PHASES, source: "undeclared", problems };
  }
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
    problems.push("runs_under must be an object");
    return { phases: [], source: "invalid", problems };
  }
  const phases = declared.database_phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    problems.push("runs_under.database_phases must be a non-empty array");
    return { phases: [], source: "invalid", problems };
  }
  const seen = new Set();
  for (const phase of phases) {
    if (typeof phase !== "string" || !KNOWN_PHASES.includes(phase)) {
      problems.push(
        `runs_under.database_phases contains ${JSON.stringify(phase)}, which is not one of ${KNOWN_PHASES.join(", ")}`,
      );
      continue;
    }
    if (seen.has(phase)) problems.push(`runs_under.database_phases lists ${JSON.stringify(phase)} twice`);
    seen.add(phase);
  }
  if (problems.length > 0) return { phases: [], source: "invalid", problems };
  return { phases: [...seen], source: "declared", problems };
}

/**
 * The verdict for switching to a release, as a pure function.
 *
 * An unreadable mode is a refusal, not a pass: this gate stands between an operator
 * and a symlink, and "I could not tell" has to behave like "no".
 */
export function judgeSwitch({ mode, phases, source }) {
  const problems = [];
  if (!KNOWN_PHASES.includes(mode)) {
    problems.push(
      `the database reports a direct-write mode this release does not know (${JSON.stringify(mode)}); refusing to switch`,
    );
    return { ok: false, problems };
  }
  if (!Array.isArray(phases) || phases.length === 0) {
    problems.push("the target release declares no database phase it can run under; refusing to switch");
    return { ok: false, problems };
  }
  if (!phases.includes(mode)) {
    const how =
      source === "undeclared"
        ? "it carries no runs_under declaration, so it is treated as a pre-mechanism release"
        : "its runs_under declaration says so";
    problems.push(
      `the database is in ${mode} and the target release cannot serve traffic in ${mode} (${how}; it declares ${phases.join(", ")}). ` +
        (mode === "strict"
          ? "Return the database to compat first — supabase/migrations/rollback_money_direct_write_contract_phase.sql, runbook §5.1 — and then re-run this rollback."
          : "Apply the phase the release requires before switching to it."),
    );
    return { ok: false, problems };
  }
  return { ok: true, problems };
}

/** The verdict for declaring the candidate complete, as a pure function. */
export function judgeCompletion({ mode }) {
  const problems = [];
  if (mode !== COMPLETION_PHASE) {
    problems.push(
      `the database is in ${JSON.stringify(mode)}; a release may only be completed in ${COMPLETION_PHASE}, ` +
        "because until the contract phase has closed the direct-write path the deferred half of this release is not deployed. " +
        (mode === "compat"
          ? "Apply the deferred phase — node scripts/db-phase-push.mjs --phase deferred_contract, runbook §4 — verify it, and finalize again."
          : "The expand phase has not been applied to this database; this release is not deployed against it at all."),
    );
    return { ok: false, problems };
  }
  return { ok: true, problems };
}

/**
 * The release manifest of a deployed release, or null when it has none.
 *
 * A release directory with no manifest is the pre-mechanism case and is reported as
 * such. A manifest that exists and cannot be parsed is NOT that case: it is a
 * refusal, because the release tried to say something and the answer was lost.
 */
export function readReleaseManifest(releaseDir) {
  const file = path.join(releaseDir, "infra", "release", "release-manifest.json");
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { manifest: null, file, present: false };
    throw new Error(`the target release's manifest could not be examined (${error.code ?? error.name})`);
  }
  if (stat.isSymbolicLink()) throw new Error("the target release's manifest is a symlink");
  if (!stat.isFile()) throw new Error("the target release's manifest is not a regular file");
  return { manifest: JSON.parse(fs.readFileSync(file, "utf8")), file, present: true };
}

/**
 * The live mode, read in a READ ONLY transaction.
 *
 * The catalog is asked first and the function second, on purpose. Calling the
 * function and treating `undefined_function` as `absent` would also treat a typo,
 * a search_path problem or a revoked grant as `absent` — the one answer that lets a
 * pre-mechanism release through. Absence has to be established positively.
 */
export async function readLiveMode(url, modulesDir) {
  const { Client } = loadPg(modulesDir);
  const client = new Client({
    connectionString: url,
    application_name: "newme-check-release-phase",
    statement_timeout: 15000,
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
  } catch (error) {
    // Never error.message: a pg connection error can quote the URL.
    throw new Error(`could not connect to the migration database (${error.code ?? error.name})`);
  }
  try {
    await client.query("begin read only");
    const present = (
      await client.query(`select exists (
                              select 1
                                from pg_catalog.pg_proc p
                                join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                               where n.nspname = 'public'
                                 and p.proname = 'money_direct_write_mode'
                                 and p.pronargs = 0
                            ) as fn`)
    ).rows[0]?.fn === true;
    if (!present) return "absent";
    const mode = (await client.query("select public.money_direct_write_mode() as mode")).rows[0]?.mode;
    return typeof mode === "string" ? mode : "unreadable";
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

function parseArgs(argv) {
  const options = { mode: null, releaseDir: null, urlFile: null, modulesDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--for-switch":
        options.mode = "switch";
        break;
      case "--for-completion":
        options.mode = "completion";
        break;
      case "--release-dir":
        options.releaseDir = value();
        break;
      case "--url-file":
        options.urlFile = value();
        break;
      case "--modules-dir":
        options.modulesDir = value();
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (options.mode === null) throw new Error("one of --for-switch or --for-completion is required");
  if (options.mode === "switch" && options.releaseDir === null) {
    throw new Error("--for-switch requires --release-dir");
  }
  if (options.urlFile === null) throw new Error("--url-file is required");
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`release phase: ${error.message}`);
    return 2;
  }

  let mode;
  try {
    mode = await readLiveMode(readUrlFile(options.urlFile), options.modulesDir);
  } catch (error) {
    console.error(`release phase: ${error.message}`);
    return 1;
  }
  console.error(`database phase     : ${mode}`);

  if (options.mode === "completion") {
    const { ok, problems } = judgeCompletion({ mode });
    for (const problem of problems) console.error(`release phase: ${problem}`);
    if (!ok) return 1;
    console.error("completion allowed : the database is strict");
    console.log(`NEWME_DB_PHASE=${mode}`);
    return 0;
  }

  let read;
  try {
    read = readReleaseManifest(options.releaseDir);
  } catch (error) {
    console.error(`release phase: ${error.message}`);
    return 1;
  }
  const { phases, source, problems: declarationProblems } = resolveDeclaredPhases(read.manifest);
  for (const problem of declarationProblems) console.error(`release phase: ${problem}`);
  console.error(
    `target declares    : ${phases.length > 0 ? phases.join(", ") : "nothing"} (${source}${read.present ? `, ${read.file}` : ", no manifest in the release"})`,
  );
  const { ok, problems } = judgeSwitch({ mode, phases, source });
  for (const problem of problems) console.error(`release phase: ${problem}`);
  if (!ok || declarationProblems.length > 0) return 1;
  console.error(`switch allowed     : the target runs under ${mode}`);
  console.log(`NEWME_DB_PHASE=${mode}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
