#!/usr/bin/env node
/**
 * Re-measure the release/database boundary immediately before the traffic switch.
 *
 * The canonical wrapper performs these checks before it installs assets, but a
 * build and readiness probe can take minutes. This coordinator deliberately runs
 * them again from the immutable candidate directory: manifest-derived required
 * and deferred sets, production history, runtime posture, hand-run companions,
 * and the database phase that admits the candidate. It receives only a path to
 * the root-owned database URL file; the credential is never an argument value or
 * output.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION_LIST = /^(?:[0-9]{14}(?:,[0-9]{14})*)?$/;

function refuse(message) {
  throw new Error(message);
}
export function parseArgs(argv) {
  const options = {
    releaseDir: "",
    status: "",
    ids: "",
    expectedRequired: "",
    expectedDeferred: "",
    urlFile: "",
    modulesDir: "",
  };
  const seen = new Set();
  const names = new Map([
    ["--release-dir", "releaseDir"],
    ["--status", "status"],
    ["--ids", "ids"],
    ["--expect-required", "expectedRequired"],
    ["--expect-deferred", "expectedDeferred"],
    ["--url-file", "urlFile"],
    ["--modules-dir", "modulesDir"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const property = names.get(key);
    if (!property) refuse(`unknown argument ${JSON.stringify(key)}`);
    if (seen.has(key)) refuse(`${key} was supplied twice`);
    if (index + 1 >= argv.length) refuse(`${key} requires a value`);
    seen.add(key);
    options[property] = argv[index + 1];
    index += 1;
  }
  for (const required of ["--release-dir", "--status", "--ids", "--expect-required", "--expect-deferred", "--url-file", "--modules-dir"]) {
    if (!seen.has(required)) refuse(`${required} is required`);
  }
  if (!path.isAbsolute(options.releaseDir)) refuse("--release-dir must be absolute");
  if (!path.isAbsolute(options.urlFile)) refuse("--url-file must be absolute");
  if (!path.isAbsolute(options.modulesDir)) refuse("--modules-dir must be absolute");
  if (!VERSION_LIST.test(options.expectedRequired)) refuse("--expect-required is not a migration-version list");
  if (!VERSION_LIST.test(options.expectedDeferred)) refuse("--expect-deferred is not a migration-version list");
  if (!new Set(["applied_verified", "reentry_verified", "not_required"]).has(options.status)) {
    refuse("--status must be applied_verified, reentry_verified or not_required");
  }
  return options;
}

function requireRegular(pathname, label) {
  let stat;
  try {
    stat = fs.lstatSync(pathname);
  } catch {
    refuse(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) refuse(`${label} must be a regular file, not a symlink`);
}

function runNode(script, args, { cwd }) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) refuse(`${path.basename(script)} could not run (${result.error.code ?? result.error.name})`);
  if (result.signal) refuse(`${path.basename(script)} was interrupted by ${result.signal}`);
  if (result.status !== 0) refuse(`${path.basename(script)} refused the pre-switch state`);
  return result.stdout ?? "";
}

function oneLine(output, key) {
  const matches = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
  if (matches.length !== 1) refuse(`release claim printed ${matches.length} ${key} lines`);
  return matches[0];
}

export function main(argv) {
  const options = parseArgs(argv);
  let releaseStat;
  try {
    releaseStat = fs.lstatSync(options.releaseDir);
  } catch {
    refuse("the candidate release directory is missing");
  }
  if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory()) {
    refuse("the candidate release must be a directory, not a symlink");
  }
  requireRegular(options.urlFile, "the migration database URL file");

  const scripts = Object.fromEntries(
    [
      "check-release-manifest.mjs",
      "verify-remote-migration-history.mjs",
      "db-phase-push.mjs",
      "check-release-phase.mjs",
    ].map((name) => {
      const pathname = path.join(options.releaseDir, "scripts", name);
      requireRegular(pathname, `candidate scripts/${name}`);
      return [name, pathname];
    }),
  );
  const migrationsDir = path.join(options.releaseDir, "supabase", "migrations");
  const historyFixture = path.join(options.releaseDir, "supabase", "migration-history-reconciliation.json");
  const releaseManifest = path.join(options.releaseDir, "infra", "release", "release-manifest.json");
  requireRegular(historyFixture, "the candidate migration-history reconciliation");
  requireRegular(releaseManifest, "the candidate release manifest");

  const claim = runNode(
    scripts["check-release-manifest.mjs"],
    ["--verify-claim", "--status", options.status, "--ids", options.ids],
    { cwd: options.releaseDir },
  );
  const required = oneLine(claim, "required_for_app");
  const deferred = oneLine(claim, "deferred_contract");
  if (!VERSION_LIST.test(required) || !VERSION_LIST.test(deferred)) {
    refuse("the candidate manifest derived a malformed migration-version set");
  }
  if (required !== options.expectedRequired || deferred !== options.expectedDeferred) {
    refuse("the candidate manifest's required/deferred sets changed after the early release gate");
  }

  const historyArgs = [
    "--url-file", options.urlFile,
    "--migrations-dir", migrationsDir,
    "--modules-dir", options.modulesDir,
    "--history-fixture", historyFixture,
    "--release-manifest", releaseManifest,
  ];
  if (options.status === "applied_verified" || options.status === "reentry_verified") {
    if (required === "") refuse(`${options.status} derived no required migration set`);
    if (options.status === "reentry_verified" && deferred === "") {
      refuse("reentry_verified requires a deferred contract migration set");
    }
    historyArgs.push("--require-applied", options.status === "reentry_verified" ? `${required},${deferred}` : required);
    if (options.status === "applied_verified" && deferred !== "") historyArgs.push("--require-unapplied", deferred);
  } else {
    historyArgs.push("--require-no-pending");
  }
  runNode(scripts["verify-remote-migration-history.mjs"], historyArgs, { cwd: options.releaseDir });

  runNode(
    scripts["db-phase-push.mjs"],
    [
      "--phase", "required_for_app",
      "--url-file", options.urlFile,
      "--modules-dir", options.modulesDir,
      options.status === "reentry_verified" ? "--verify-recorded-posture" : "--verify-only",
    ],
    { cwd: options.releaseDir },
  );

  runNode(scripts["check-release-manifest.mjs"], ["--verify-companions"], { cwd: options.releaseDir });

  const phase = runNode(
    scripts["check-release-phase.mjs"],
    [
      "--for-switch",
      "--release-dir", options.releaseDir,
      "--url-file", options.urlFile,
      "--modules-dir", options.modulesDir,
    ],
    { cwd: options.releaseDir },
  );
  const livePhase = oneLine(phase, "NEWME_DB_PHASE");
  if (options.status === "reentry_verified" && livePhase !== "compat") {
    refuse(`reentry_verified requires live database phase compat, not ${JSON.stringify(livePhase)}`);
  }
  console.log(`pre-switch revalidation: required=${required === "" ? 0 : required.split(",").length} deferred=${deferred === "" ? 0 : deferred.split(",").length} history=verified posture=verified companions=verified phase=verified`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`pre-switch release gate: ${error.message}`);
    process.exitCode = 1;
  }
}
