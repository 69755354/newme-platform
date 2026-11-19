#!/usr/bin/env node
/**
 * OS fix S20: data-import operations behind the release gate
 * (newme-deploy db-transition <main-sha> <ci-run> data-import-plan|data-import-apply|data-import-rollback).
 *
 * The import program, its rollback program and the data bundle are NOT in this repository. They
 * sit in a root-only directory (/opt/newme-import/current) next to a MANIFEST of sha256 hashes.
 * This runner:
 *   - verifies that directory (check-s20-import-gate.mjs) and stages a hash-checked copy of the
 *     programs into a root-only work directory, so what is hashed is what runs;
 *   - plan: runs the program read-only (the program makes the database itself refuse writes),
 *     prints counts only and writes a plan file named by its own sha256;
 *   - apply: needs the expected bundle hash, the plan file hash and count bounds; re-plans and
 *     refuses on any difference; takes an encrypted database backup first; runs the program in
 *     its single transaction; checks that notifications, Meta stage events, WhatsApp CAPI events
 *     and tasks did not change; on any failure rolls back with the rollback program from the
 *     manifest it wrote;
 *   - rollback <run-id>: undoes one recorded run (last in, first out).
 * It never prints program output (it can quote customer data); program logs go to root-only
 * files in the state directory. The database URL comes from the migration URL file and is handed
 * to the program through the environment only.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode } from "./check-release-phase.mjs";
import { PROGRAM_FILES, DATA_FILE, PAYLOAD_FILES, sha256Hex, verifyImportDir } from "./check-s20-import-gate.mjs";

export const OPERATIONS = Object.freeze(["data-import-plan", "data-import-apply", "data-import-rollback"]);
export const DEFAULT_IMPORT_DIR = "/opt/newme-import/current";
export const DEFAULT_STATE_DIR = "/var/backups/newme-import";
export const DEFAULT_BACKUP_DIR = "/var/backups/newme-db";
export const BACKUP_UNIT = "newme-db-backup.service";
export const CANONICAL_MIRROR = "/opt/newme/repository.git";
export const PLAN_SCHEMA = "newme-s20-import-plan/1";
export const PLAN_MAX_AGE_MS = 24 * 3600 * 1000;
// Tables whose row counts must be identical before and after an import: the import must not
// notify anyone, queue a Meta/WhatsApp event or create a task.
export const SIDE_EFFECT_TABLES = Object.freeze(["notifications", "meta_crm_stage_events", "whatsapp_capi_events", "tasks"]);
export const COUNT_TABLES = Object.freeze(["leads", ...SIDE_EFFECT_TABLES]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PLAN_COUNT_FIELDS = ["insert", "unarchive", "update", "noop", "skipped", "held", "conflicts", "total_leads", "to_archive", "unarchived_before", "expected_unarchived_after"];
const LIVE_STATES = ["applied", "started", "rollback_failed"];

// --- argument grammar --------------------------------------------------------------------------

/** Extra command-line words after the operation name. Anything else is refused. */
export function parseOperationArgs(operation, words) {
  const out = { expectedBundle: null, planHash: null, minLeads: null, maxLeads: null, archivedBatch: null, runId: null };
  const list = [...words];
  const int = (value, what) => {
    if (!/^[0-9]{1,7}$/.test(value ?? "")) throw Error(`${what} must be a whole number`);
    return Number(value);
  };
  if (operation === "data-import-plan") {
    if (list.length) throw Error("data-import-plan takes no extra arguments");
    return out;
  }
  if (operation === "data-import-rollback") {
    if (list.length !== 1 || !UUID.test(list[0])) throw Error("data-import-rollback takes exactly one run id");
    out.runId = list[0];
    return out;
  }
  if (operation !== "data-import-apply") throw Error("unknown data-import operation");
  if (!HEX64.test(list[0] ?? "") || !HEX64.test(list[1] ?? "")) throw Error("data-import-apply needs <expected-bundle-sha256> <plan-sha256> --min-leads N --max-leads N");
  out.expectedBundle = list[0];
  out.planHash = list[1];
  for (let i = 2; i < list.length; i += 2) {
    const flag = list[i];
    const value = list[i + 1];
    if (flag === "--min-leads" && out.minLeads === null) out.minLeads = int(value, "--min-leads");
    else if (flag === "--max-leads" && out.maxLeads === null) out.maxLeads = int(value, "--max-leads");
    else if (flag === "--require-archived-batch" && out.archivedBatch === null) {
      if (!UUID.test(value ?? "")) throw Error("--require-archived-batch needs a batch id");
      out.archivedBatch = value;
    } else throw Error("invalid data-import-apply arguments");
  }
  if (out.minLeads === null || out.maxLeads === null || out.minLeads > out.maxLeads) throw Error("--min-leads and --max-leads are required and must satisfy min <= max");
  return out;
}

// --- plan summary and judgement ------------------------------------------------------------------

/** Reduce the program's plan.json to numbers only. */
export function summarizePlan(plan) {
  const counts = plan?.counts;
  if (!counts || typeof counts !== "object") throw Error("the program's plan has no counts");
  const by = counts.leads_by_action ?? {};
  const num = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const insert = num(by.INSERT ?? 0);
  const updateAll = num(by.UPDATE ?? 0);
  const noop = num(by.NOOP ?? 0);
  const unarchive = num(counts.unarchived_on_match);
  const out = {
    insert,
    unarchive,
    update: unarchive === null || updateAll === null ? null : Math.max(0, updateAll - unarchive),
    noop,
    skipped: num(counts.skipped),
    held: num(counts.held),
    conflicts: num(counts.conflicts),
    to_archive: num(counts.to_archive),
    unarchived_before: num(counts.os_leads_unarchived_before),
    expected_unarchived_after: num(counts.expected_unarchived_after),
    side_effects_planned: {
      notifications: num(counts.notifications_to_create),
      meta_crm_stage_events: num(counts.meta_crm_stage_events_to_enqueue),
      tasks: num(counts.tasks_to_create),
    },
  };
  out.total_leads = [out.insert, out.unarchive, out.update, out.noop].some((v) => v === null) ? null : out.insert + out.unarchive + out.update + out.noop;
  for (const field of PLAN_COUNT_FIELDS) if (out[field] === null) throw Error(`the program's plan lacks a valid ${field} count`);
  for (const value of Object.values(out.side_effects_planned)) if (value === null) throw Error("the program's plan does not declare its side-effect counts");
  return out;
}

const sameCounts = (a, b) => PLAN_COUNT_FIELDS.every((field) => a?.[field] === b?.[field]) &&
  JSON.stringify(a?.side_effects_planned) === JSON.stringify(b?.side_effects_planned);

/** Everything that can be decided without touching the database. */
export function judgeApply({ args, bundleSha256, manifestSha256, hashes, planFile, planActualHash, summary, now }) {
  const problems = [];
  if (args.expectedBundle !== bundleSha256) problems.push("the expected bundle hash does not match the bundle on disk");
  if (planActualHash !== args.planHash) problems.push("the plan file hash does not match");
  const plan = planFile ?? {};
  if (plan.schema !== PLAN_SCHEMA) problems.push("the plan file has an unknown schema");
  if (plan.bundle_sha256 !== bundleSha256) problems.push("the plan was made for a different bundle");
  if (plan.manifest_sha256 !== manifestSha256) problems.push("the plan was made for a different MANIFEST");
  for (const name of PROGRAM_FILES) if (plan.programs?.[name] !== hashes?.[name]) problems.push(`the plan was made with a different ${name}`);
  const age = now - Date.parse(plan.created_at ?? "");
  if (!Number.isFinite(age) || age < 0 || age > PLAN_MAX_AGE_MS) problems.push("the plan is older than 24 hours or dated in the future");
  if (!sameCounts(plan.counts, summary)) problems.push("the current plan counts differ from the approved plan file");
  if (summary.total_leads < args.minLeads || summary.total_leads > args.maxLeads) problems.push("the lead count is outside the allowed bounds");
  if (summary.to_archive !== 0) problems.push("the program wants to archive leads; the gate does not allow that");
  if (Object.values(summary.side_effects_planned).some((value) => value !== 0)) problems.push("the program plans notifications, Meta events or tasks");
  return [...new Set(problems)];
}

/** Tables (of the four side-effect tables) whose count differs, or is unknown. */
export const judgeSideEffects = (before, after) =>
  SIDE_EFFECT_TABLES.filter((table) => before?.[table] === undefined || after?.[table] === undefined || before[table] !== after[table]);

const sameBaseline = (a, b) => COUNT_TABLES.every((table) => a?.[table] === b?.[table]) && a?.leads_unarchived === b?.leads_unarchived;

// --- real dependencies ---------------------------------------------------------------------------

function makePgDb({ url, modulesDir }) {
  const session = async (work) => {
    const { Client } = loadPg(modulesDir);
    const client = new Client({ connectionString: url, application_name: "newme-data-import-gate", statement_timeout: 30000, connectionTimeoutMillis: 15000 });
    try {
      await client.connect();
    } catch (error) {
      throw Error(`could not connect to the migration database (${error.code ?? error.name})`);
    }
    try {
      await client.query("begin read only");
      return await work(client);
    } catch (error) {
      throw Error(`database read refused (${error.code ?? error.name})`);
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  };
  return {
    phase: () => readLiveMode(url, modulesDir),
    counts: () => session(async (client) => {
      const out = {};
      for (const table of COUNT_TABLES) {
        const present = (await client.query("select to_regclass($1) is not null as present", [`public.${table}`])).rows[0].present;
        out[table] = present ? (await client.query(`select count(*)::int as n from public.${table}`)).rows[0].n : null;
      }
      out.leads_unarchived = (await client.query("select count(*)::int as n from public.leads where not archived")).rows[0].n;
      return out;
    }),
    archivedBatchCount: (id) => session(async (client) => (await client.query("select count(*)::int as n from public.leads where archive_batch_id = $1::uuid", [id])).rows[0].n),
  };
}

/** Start the encrypted backup unit and find the new, checksummed dump. Throws when there is none. */
export function takeBackup({ backupDir = DEFAULT_BACKUP_DIR, unit = BACKUP_UNIT, spawn = spawnSync, now = () => Date.now() } = {}) {
  const dumps = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((n) => /^newme-prod-.*\.dump\.enc$/.test(n)) : []);
  const known = new Set(dumps());
  const startedAt = now();
  const started = spawn("systemctl", ["start", unit], { encoding: "utf8", timeout: 35 * 60 * 1000 });
  if (started.error || started.status !== 0) throw Error("the database backup service did not complete");
  const created = dumps().filter((n) => !known.has(n)).map((n) => ({ n, stat: fs.statSync(path.join(backupDir, n)) }))
    .filter(({ stat }) => stat.isFile() && stat.size > 0 && stat.mtimeMs >= startedAt - 5000)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (!created.length) throw Error("no new backup file appeared");
  const { n, stat } = created[0];
  const sumFile = path.join(backupDir, `${n}.sha256`);
  if (!fs.existsSync(sumFile)) throw Error("the new backup has no checksum file");
  const recorded = fs.readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
  const actual = sha256Hex(fs.readFileSync(path.join(backupDir, n)));
  if (recorded !== actual) throw Error("the new backup does not match its checksum");
  return { file: n, sha256: actual, bytes: stat.size };
}

function canonicalMain() {
  return execFileSync("git", ["--git-dir", CANONICAL_MIRROR, "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" }).trim();
}

// --- state directory -------------------------------------------------------------------------------

function ensureDir(dir, uid) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw Error(`state directory ${path.basename(dir)} must be a real directory owned by root with mode 0700`);
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
}

function readPrivate(file, uid) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw Error("a state file has unsafe ownership or mode");
  return fs.readFileSync(file);
}

function saveRun(runDir, run) {
  const file = path.join(runDir, "run.json");
  fs.writeFileSync(`${file}.next`, `${JSON.stringify(run, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.next`, file);
}

// --- program execution -------------------------------------------------------------------------------

function stageProgram({ importDir, workDir, modulesDir, expected }) {
  const dir = path.join(workDir, "program");
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of PAYLOAD_FILES) {
    fs.copyFileSync(path.join(importDir, name), path.join(dir, name));
    fs.chmodSync(path.join(dir, name), 0o600);
    if (sha256Hex(fs.readFileSync(path.join(dir, name))) !== expected[name]) throw Error(`${name} changed while it was being staged`);
  }
  if (modulesDir) fs.symlinkSync(modulesDir, path.join(dir, "node_modules"));
  return dir;
}

function runProgram({ dir, script, args, url, extraEnv, logFile, expectedHash }) {
  if (sha256Hex(fs.readFileSync(path.join(dir, script))) !== expectedHash) throw Error(`${script} changed after it was verified`);
  const fd = fs.openSync(logFile, "a", 0o600);
  try {
    const result = spawnSync(process.execPath, [path.join(dir, script), ...args], {
      cwd: dir,
      stdio: ["ignore", fd, fd],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, NEWME_IMPORT_DB_URL: url, ...extraEnv },
      timeout: 30 * 60 * 1000,
    });
    return { status: result.error ? null : result.status };
  } finally {
    fs.closeSync(fd);
  }
}

// --- the operations ------------------------------------------------------------------------------------

/**
 * deps (the command line never sets them; tests do):
 *   db, backup, canonicalMain, uid, now, id, programEnv, log, url
 */
export async function runDataImport({ operation, words = [], mainSha, importDir = DEFAULT_IMPORT_DIR, stateDir = DEFAULT_STATE_DIR, urlFile, modulesDir, deps = {} }) {
  if (!OPERATIONS.includes(operation)) throw Error("unknown data-import operation");
  if (!/^[0-9a-f]{40}$/.test(mainSha ?? "")) throw Error("a 40-character main SHA is required");
  const args = parseOperationArgs(operation, words);
  const ctx = {
    args, importDir, stateDir, modulesDir, mainSha, deps,
    uid: deps.uid ?? 0,
    now: deps.now ?? (() => Date.now()),
    log: deps.log ?? ((line) => console.log(line)),
    extraEnv: deps.programEnv ?? {},
  };
  ctx.url = deps.url ?? readUrlFile(urlFile);
  ctx.db = deps.db ?? makePgDb({ url: ctx.url, modulesDir });
  const mainNow = deps.canonicalMain ?? canonicalMain;
  ctx.assertCanonical = () => {
    if (mainNow() !== mainSha) throw Error("canonical main moved away from the protected operation SHA");
  };

  ctx.assertCanonical();
  ensureDir(stateDir, ctx.uid);
  for (const sub of ["plans", "runs", "work"]) ensureDir(path.join(stateDir, sub), ctx.uid);
  const lock = path.join(stateDir, ".lock");
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    throw Error("another data-import operation holds the lock (or a crashed one left it); inspect the state directory before removing .lock");
  }
  try {
    ctx.directory = verifyImportDir(importDir, { expectedUid: ctx.uid });
    const phase = await ctx.db.phase();
    const refusals = [...ctx.directory.problems];
    if (phase !== "strict") refusals.push("the database must be in the strict phase");
    if (refusals.length) throw Error(refusals.join("; "));
    return operation === "data-import-rollback" ? await rollback(ctx) : await planOrApply(ctx, operation === "data-import-apply");
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

async function planOrApply(ctx, isApply) {
  const { args, directory, db, importDir, stateDir, uid, now, log, url, extraEnv, modulesDir, mainSha, deps } = ctx;
  const id = deps.id ? deps.id() : randomUUID();
  const workDir = path.join(stateDir, "work", id);
  fs.mkdirSync(workDir, { mode: 0o700 });
  const programDir = stageProgram({ importDir, workDir, modulesDir, expected: directory.hashes });
  const logFile = path.join(workDir, "program.log");

  const dryRun = () => {
    const runDir = path.join(workDir, "plan");
    const result = runProgram({
      dir: programDir, script: "import_sheets.mjs", url, extraEnv, logFile, expectedHash: directory.hashes["import_sheets.mjs"],
      args: ["--input", path.join(programDir, DATA_FILE), "--target", "production", "--run-dir", runDir],
    });
    if (result.status !== 0) throw Error(`the import program's read-only plan failed (exit ${result.status}); see ${logFile}`);
    return summarizePlan(JSON.parse(readPrivate(path.join(runDir, "plan.json"), uid).toString("utf8")));
  };

  const baseline = await db.counts();
  const summary = dryRun();
  const afterPlan = await db.counts();
  if (!sameBaseline(baseline, afterPlan)) throw Error("the database changed during the read-only plan; stop and investigate");

  if (!isApply) {
    const planFile = {
      schema: PLAN_SCHEMA, run_id: id, created_at: new Date(now()).toISOString(), main_sha: mainSha,
      bundle_sha256: directory.bundleSha256, manifest_sha256: directory.manifestSha256,
      programs: Object.fromEntries(PROGRAM_FILES.map((name) => [name, directory.hashes[name]])),
      counts: summary, baseline,
    };
    const text = `${JSON.stringify(planFile, null, 1)}\n`;
    const planHash = sha256Hex(text);
    writePrivate(path.join(stateDir, "plans", `plan-${planHash}.json`), text);
    log("data-import plan (read-only; nothing was written)");
    log(`bundle_sha256=${directory.bundleSha256}`);
    log(`manifest_sha256=${directory.manifestSha256}`);
    log(`insert=${summary.insert} unarchive=${summary.unarchive} update=${summary.update} noop=${summary.noop} skipped=${summary.skipped} held=${summary.held} conflicts=${summary.conflicts}`);
    log(`total_leads=${summary.total_leads} unarchived_before=${summary.unarchived_before} expected_unarchived_after=${summary.expected_unarchived_after}`);
    log(`side_effects_planned=${JSON.stringify(summary.side_effects_planned)}`);
    log(`plan_sha256=${planHash}`);
    return { planHash, summary };
  }

  // --- apply ---
  const planPath = path.join(stateDir, "plans", `plan-${args.planHash}.json`);
  if (!fs.existsSync(planPath)) throw Error("no plan file with that hash exists");
  const planBytes = readPrivate(planPath, uid);
  const planFile = JSON.parse(planBytes.toString("utf8"));
  const problems = judgeApply({
    args, bundleSha256: directory.bundleSha256, manifestSha256: directory.manifestSha256, hashes: directory.hashes,
    planFile, planActualHash: sha256Hex(planBytes), summary, now: now(),
  });
  if (args.archivedBatch && (await db.archivedBatchCount(args.archivedBatch)) === 0) problems.push("the required archive batch has no archived leads");
  if (problems.length) throw Error(problems.join("; "));

  const backup = deps.backup ? await deps.backup() : takeBackup();
  if (!backup?.file || !HEX64.test(backup.sha256 ?? "")) throw Error("no verified backup; refusing to write");
  log(`backup=${backup.file} sha256=${backup.sha256} bytes=${backup.bytes}`);
  const before = await db.counts();
  if (!sameBaseline(baseline, before)) throw Error("the database changed during the backup; re-plan");
  ctx.assertCanonical();

  const runDir = path.join(stateDir, "runs", id);
  fs.mkdirSync(runDir, { mode: 0o700 });
  const programRunDir = path.join(runDir, "program-run");
  const run = {
    schema: "newme-s20-import-run/1", run_id: id, state: "started", started_at: new Date(now()).toISOString(), main_sha: mainSha,
    plan_sha256: args.planHash, bundle_sha256: directory.bundleSha256, manifest_sha256: directory.manifestSha256,
    programs: planFile.programs, counts: summary, baseline: before, backup, program_run_dir: programRunDir,
  };
  saveRun(runDir, run);
  const runLog = path.join(runDir, "apply.log");
  const manifestFile = path.join(programRunDir, "rollback-manifest.json");

  const result = runProgram({
    dir: programDir, script: "import_sheets.mjs", url, extraEnv, logFile: runLog, expectedHash: directory.hashes["import_sheets.mjs"],
    args: ["--input", path.join(programDir, DATA_FILE), "--target", "production", "--apply", "--confirm-production", "--run-dir", programRunDir],
  });

  const failures = [];
  let manifest = null;
  try {
    manifest = JSON.parse(readPrivate(manifestFile, uid).toString("utf8"));
  } catch {
    failures.push("no readable rollback manifest");
  }
  if (result.status !== 0) failures.push(`the import program exited with ${result.status}`);
  if (manifest && manifest.committed !== true) failures.push("the import did not commit");
  // A failed read after the commit (connection lost, timeout) must take the same rollback path as a mismatch.
  let after = null;
  try {
    after = await db.counts();
  } catch (error) {
    failures.push(`post-commit verification failed (${error?.code ?? "database error"})`);
  }
  const touched = after ? judgeSideEffects(before, after) : [];
  if (touched.length) failures.push(`side-effect tables changed: ${touched.join(", ")}`);
  if (after && manifest?.committed === true) {
    if (after.leads !== before.leads + (manifest.inserted_leads?.length ?? -1)) failures.push("lead total does not equal before plus inserted");
    if (after.leads_unarchived !== summary.expected_unarchived_after) failures.push("unarchived lead count differs from the plan");
  }

  if (!failures.length) {
    run.state = "applied";
    run.finished_at = new Date(now()).toISOString();
    run.counts_after = after;
    saveRun(runDir, run);
    log("data-import apply committed");
    log(`run_id=${id}`);
    log(`inserted=${manifest.inserted_leads.length} updated=${manifest.updated_leads?.length ?? 0} unarchived=${summary.unarchive}`);
    log(`side_effect_tables_unchanged=${SIDE_EFFECT_TABLES.join(",")}`);
    log(`rollback with: newme-deploy db-transition <main-sha> <ci-run> data-import-rollback ${id}`);
    return { runId: id, state: "applied", counts_after: after };
  }

  // Failure path: undo anything that committed, then prove the database is back at the baseline.
  let restored = true;
  if (manifest?.committed === true) {
    const undone = runProgram({
      dir: programDir, script: "rollback_import.mjs", url, extraEnv, logFile: runLog, expectedHash: directory.hashes["rollback_import.mjs"],
      args: ["--manifest", manifestFile, "--target", "production", "--apply", "--confirm-production"],
    });
    restored = undone.status === 0;
  }
  const settled = await db.counts().catch(() => null);
  const clean = restored && settled !== null && sameBaseline(settled, before);
  run.state = clean ? "failed_rolled_back" : "rollback_failed";
  run.failures = failures;
  run.finished_at = new Date(now()).toISOString();
  saveRun(runDir, run);
  if (!clean) throw Error(`apply failed (${failures.join("; ")}) AND the database is not back at the baseline; stop; backup ${backup.file}; run ${id}`);
  throw Error(`apply failed and was rolled back (${failures.join("; ")}); the database matches the baseline; run ${id}`);
}

async function rollback(ctx) {
  const { args, directory, db, stateDir, uid, now, log, url, extraEnv, modulesDir, importDir } = ctx;
  const runDir = path.join(stateDir, "runs", args.runId);
  if (!fs.existsSync(path.join(runDir, "run.json"))) throw Error("no such import run");
  const run = JSON.parse(readPrivate(path.join(runDir, "run.json"), uid).toString("utf8"));
  if (run.run_id !== args.runId) throw Error("the run record does not belong to this run id");
  if (!LIVE_STATES.includes(run.state)) throw Error(`this run is ${run.state}; nothing to roll back`);
  // last in, first out: a later run that is still in place must be undone first
  for (const name of fs.readdirSync(path.join(stateDir, "runs"))) {
    if (name === args.runId) continue;
    const other = path.join(stateDir, "runs", name, "run.json");
    if (!fs.existsSync(other)) continue;
    const record = JSON.parse(readPrivate(other, uid).toString("utf8"));
    if (LIVE_STATES.includes(record.state) && record.started_at > run.started_at) throw Error(`a later import run (${record.run_id}) is still in place; roll that back first`);
  }
  if (directory.hashes["rollback_import.mjs"] !== run.programs?.["rollback_import.mjs"]) throw Error("the rollback program differs from the one that was recorded for this run");
  const manifestFile = path.join(run.program_run_dir, "rollback-manifest.json");
  ctx.assertCanonical();
  const workDir = path.join(stateDir, "work", `rollback-${args.runId}-${now()}`);
  fs.mkdirSync(workDir, { mode: 0o700 });
  const programDir = stageProgram({ importDir, workDir, modulesDir, expected: directory.hashes });
  const common = { dir: programDir, script: "rollback_import.mjs", url, extraEnv, logFile: path.join(runDir, "rollback.log"), expectedHash: directory.hashes["rollback_import.mjs"] };
  const preview = runProgram({ ...common, args: ["--manifest", manifestFile, "--target", "production"] });
  if (preview.status !== 0) throw Error("the rollback preview failed; nothing was changed");
  const done = runProgram({ ...common, args: ["--manifest", manifestFile, "--target", "production", "--apply", "--confirm-production"] });
  const after = await db.counts();
  if (done.status !== 0 || !sameBaseline(after, run.baseline)) {
    run.state = "rollback_failed";
    saveRun(runDir, run);
    throw Error(`rollback did not restore the baseline counts; restore from backup ${run.backup?.file}; run ${args.runId}`);
  }
  run.state = "rolled_back";
  run.rolled_back_at = new Date(now()).toISOString();
  saveRun(runDir, run);
  log("data-import rollback complete");
  log(`run_id=${args.runId}`);
  log(`counts_match_baseline=true leads=${after.leads} unarchived=${after.leads_unarchived}`);
  return { runId: args.runId, state: "rolled_back" };
}

// --- command line --------------------------------------------------------------------------------------------

async function main(argv) {
  const flags = new Map();
  let i = 0;
  for (; i < argv.length && argv[i] !== "--"; i += 2) {
    if (!["--operation", "--main-sha", "--url-file", "--modules-dir"].includes(argv[i]) || !argv[i + 1] || flags.has(argv[i])) throw Error("invalid data-import arguments");
    flags.set(argv[i], argv[i + 1]);
  }
  if (argv[i] !== "--" || flags.size !== 4) throw Error("invalid data-import arguments");
  await runDataImport({
    operation: flags.get("--operation"), words: argv.slice(i + 1), mainSha: flags.get("--main-sha"),
    urlFile: flags.get("--url-file"), modulesDir: flags.get("--modules-dir"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
