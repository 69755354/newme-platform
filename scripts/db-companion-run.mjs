#!/usr/bin/env node
/**
 * Canonical runner for the two production money-phase companions.
 *
 * This helper intentionally accepts an operation name, not a path. The canonical
 * host wrapper supplies the exact-SHA worktree, the fixed root-owned URL file and
 * the live release's installed `pg` module while holding the same release lock as
 * deploy and rollback. The manifest binds the selected file to its shipped hash.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ROOT,
  auditManifest,
  contentHash,
  readBaseline,
  readManifest,
  readMigration,
  readTreeFiles,
} from "./check-release-manifest.mjs";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";

const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

export const OPERATIONS = Object.freeze({
  "contract-rollback": Object.freeze({
    file: "rollback_money_direct_write_contract_phase.sql",
    phase: "required_for_app",
    expectedMode: "compat",
  }),
  "contract-reenter": Object.freeze({
    file: "recontract_money_direct_write_contract_phase.sql",
    phase: "deferred_contract",
    expectedMode: "strict",
  }),
});

export function parseArgs(argv) {
  const options = { operation: null, urlFile: null, modulesDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--operation":
        options.operation = next();
        break;
      case "--url-file":
        options.urlFile = next();
        if (/^postgres(ql)?:\/\//.test(options.urlFile)) {
          throw new Error("the connection string must be read from a file, never passed as an argument");
        }
        break;
      case "--modules-dir":
        options.modulesDir = next();
        break;
      default:
        throw new Error(
          arg.startsWith("--url=") || /postgres(ql)?:\/\//.test(arg)
            ? "the connection string must be read from a file, never passed as an argument"
            : `unknown argument: ${arg}`,
        );
    }
  }
  if (!Object.hasOwn(OPERATIONS, options.operation)) {
    throw new Error(`--operation must be one of ${Object.keys(OPERATIONS).join(", ")}`);
  }
  if (!options.urlFile) throw new Error("--url-file is required");
  if (!options.modulesDir) throw new Error("--modules-dir is required");
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const selected = OPERATIONS[options.operation];
  const manifest = readManifest();
  const { files, hashes } = readTreeFiles(MIGRATIONS_DIR);
  const problems = auditManifest({ manifest, files, hashes, baseline: readBaseline() });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`release manifest: ${problem}`);
    console.error("refusing: the release manifest does not describe this tree");
    return 1;
  }

  const matches = (manifest.companions ?? []).filter((entry) => entry?.file === selected.file);
  if (matches.length !== 1) {
    console.error(`refusing: the manifest does not declare exactly one ${selected.file}`);
    return 1;
  }
  const entry = matches[0];
  const sql = readMigration(MIGRATIONS_DIR, selected.file);
  if (contentHash(sql) !== entry.sha256) {
    console.error(`refusing: ${selected.file} does not match the manifest hash`);
    return 1;
  }

  const predicates = manifest.posture?.[selected.phase]?.predicates;
  if (!Array.isArray(predicates) || predicates.length === 0) {
    console.error(`refusing: the manifest declares no ${selected.phase} posture predicates`);
    return 1;
  }

  const { Client } = loadPg(options.modulesDir);
  const client = new Client({
    connectionString: readUrlFile(options.urlFile),
    application_name: `newme-db-companion-${options.operation}`,
    connectionTimeoutMillis: 20000,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`could not connect to the migration database (${error.code ?? error.name})`);
  }

  let failures = 0;
  try {
    try {
      await client.query(sql);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      console.error(`refusing: ${selected.file} failed (SQLSTATE ${error.code ?? "unknown"})`);
      return 1;
    }

    await client.query("begin read only");
    let measuredMode;
    try {
      measuredMode = (await client.query("select public.money_direct_write_mode() as mode")).rows[0]?.mode;
    } catch (error) {
      console.error(`posture: release mode could not be evaluated (SQLSTATE ${error.code ?? "unknown"})`);
      failures += 1;
    }
    if (measuredMode !== undefined && measuredMode !== selected.expectedMode) {
      console.error(`posture: release mode is not ${selected.expectedMode}`);
      failures += 1;
    }

    for (const predicate of predicates) {
      let result;
      try {
        result = (await client.query(predicate.sql)).rows[0];
      } catch (error) {
        console.error(`posture: ${predicate.name} could not be evaluated (SQLSTATE ${error.code ?? "unknown"})`);
        failures += 1;
        continue;
      }
      const actual = result ? Object.values(result)[0] : null;
      if (actual !== predicate.expect) {
        console.error(`posture: ${predicate.name} did not match its manifest expectation`);
        failures += 1;
      }
    }
    await client.query("commit");
  } finally {
    await client.end().catch(() => {});
  }

  if (failures > 0) {
    console.error(`refusing: ${failures} post-companion verification failure(s)`);
    return 1;
  }
  console.log(`OK operation=${options.operation} mode=${selected.expectedMode} manifest=${manifest.release}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`db companion: ${error.message}`);
      process.exit(1);
    },
  );
}
