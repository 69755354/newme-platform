/**
 * The control-plane bootstrap guard (round-3 finding P1-10).
 *
 * Production's /usr/local/sbin/newme-deploy is still the old f37c203 wrapper. It
 * does not pass CI_EVENT and it does not run the taskboard, remote-history or
 * job-level gates — but it does call the candidate release's
 * scripts/install-systemd-assets.sh, which replaces the entire control plane. So
 * the first deployment performed by the old wrapper would install the new control
 * plane without any of the new preconditions having been checked, and the asset
 * backup set did not include the wrapper, so it could not be undone.
 *
 * This script is the precondition. The candidate wrapper writes a gate record
 * after every gate it runs has passed, and the installer refuses to touch
 * anything — before the pending-transaction recovery, before the control plane,
 * before any versioned asset — unless this script accepts that record. A wrapper
 * that does not know about gate records (every wrapper before this revision, the
 * f37c203 one included) therefore cannot install anything at all.
 *
 * The record is not a token. It is bound to:
 *   * the exact release SHA the installer is about to install, so a record from
 *     another release or another run is not usable
 *   * the named gates, so adding a gate to the wrapper and forgetting to run it
 *     is a refusal
 *   * a short freshness window, so a record left behind by an earlier deployment
 *     of the same SHA cannot be replayed
 *   * root ownership and 0600 inside the protected 0700 deploy-state directory,
 *     so it cannot be forged by a non-root process
 *
 * It contains no secret: a SHA, a run id, an event name and gate names.
 *
 * Usage:
 *   node scripts/verify-deploy-gate-record.mjs \
 *     --record /var/lib/newme/deploy-state/deploy-gates.XXXXXX \
 *     --expect-sha <40-hex release sha> \
 *     [--state-root /var/lib/newme/deploy-state] [--max-age-seconds 900] \
 *     [--now-ms <epoch ms>]
 *
 * Exit 0 only when the record is present, well-formed, fresh, root-owned and
 * accounts for every required gate. Anything else exits 1 with the reason.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The gates the wrapper must have run before the control plane may be replaced.
 * This list is the contract: infra/systemd/newme-deploy.sh writes exactly these
 * names, tests/release/control-plane-bootstrap-contract.test.mjs holds the two
 * sides equal, and a gate added to the wrapper without being added here would not
 * be required of anyone.
 */
export const REQUIRED_GATES = [
  // The release is the canonical main SHA in the root-owned mirror, and main
  // carries the rollback-preserving immutable deploy script.
  "canonical-main-verified",
  // The exact-head workflow_dispatch run is green and every required job in
  // infra/release/required-jobs.json ran and succeeded.
  "github-required-jobs-green",
  // TASKBOARD.md at that tree is complete, checked with that tree's checker.
  "taskboard-complete",
  // Production's recorded migration history matches the release, reconciled.
  "remote-migration-history",
];

export const DEFAULT_STATE_ROOT = "/var/lib/newme/deploy-state";
export const DEFAULT_MAX_AGE_SECONDS = 900;
/** Clock skew tolerated in the other direction before a record is "impossible". */
const FUTURE_TOLERANCE_MS = 60_000;
const RECORD_BASENAME = /^deploy-gates\.[A-Za-z0-9]{6,}$/;

/**
 * The judgement, as a pure function of the record text and its metadata, so the
 * whole guard is testable without a deploy host.
 */
export function checkGateRecord({
  text,
  expectSha,
  mtimeMs,
  nowMs,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
}) {
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(String(expectSha ?? ""))) {
    problems.push("the expected release SHA is not a 40-character hex commit id");
  }

  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  const values = new Map();
  const gates = [];
  for (const line of lines) {
    const match = /^([a-z_]+)=(.*)$/.exec(line);
    if (!match) {
      problems.push(`the gate record has a line that is not key=value: ${JSON.stringify(line)}`);
      continue;
    }
    const [, key, value] = match;
    if (key === "gate") {
      if (gates.includes(value)) problems.push(`the gate record names ${JSON.stringify(value)} twice`);
      gates.push(value);
      continue;
    }
    if (!["sha", "event", "run"].includes(key)) {
      problems.push(`the gate record has an unknown key ${JSON.stringify(key)}`);
      continue;
    }
    if (values.has(key)) problems.push(`the gate record sets ${key} twice`);
    values.set(key, value);
  }

  if (values.get("sha") !== expectSha) {
    // The whole point: a record is about one release, not about "a deployment".
    problems.push(
      `the gate record is for ${JSON.stringify(values.get("sha") ?? "")} but the release being installed is ${JSON.stringify(String(expectSha ?? ""))}`,
    );
  }
  if (values.get("event") !== "workflow_dispatch") {
    problems.push(
      `the gate record records event ${JSON.stringify(values.get("event") ?? "")}; only a release-final workflow_dispatch run is evidence`,
    );
  }
  if (!/^[0-9]{1,20}$/.test(String(values.get("run") ?? ""))) {
    problems.push("the gate record does not name the workflow run it was verified against");
  }

  const missing = REQUIRED_GATES.filter((gate) => !gates.includes(gate));
  if (missing.length > 0) {
    problems.push(`the gate record does not account for: ${missing.join(", ")}`);
  }
  const unknown = gates.filter((gate) => !REQUIRED_GATES.includes(gate));
  if (unknown.length > 0) {
    // Not pedantry: a wrapper claiming gates this installer has never heard of is
    // a wrapper from a different release, and it cannot be given the benefit of
    // the doubt about the ones it does name.
    problems.push(`the gate record claims gates this installer does not know: ${unknown.join(", ")}`);
  }

  const ageMs = nowMs - mtimeMs;
  if (ageMs > maxAgeSeconds * 1000) {
    problems.push(
      `the gate record is ${Math.round(ageMs / 1000)}s old, older than the ${maxAgeSeconds}s window: it is not evidence about this deployment`,
    );
  }
  if (ageMs < -FUTURE_TOLERANCE_MS) {
    problems.push("the gate record is dated in the future");
  }
  return problems;
}

/**
 * Who may have written the record, as a pure function of the two stat results, so
 * a test can assert both answers without being root and without a deploy host.
 * `enforce` is false only where the platform does not report POSIX ownership at
 * all (Windows reports uid 0 and synthetic modes for every file, so believing it
 * would turn this check into a rubber stamp there); the deploy host is Linux and
 * runs this as root, where it is always enforced.
 */
export function checkOwnership({
  recordStat,
  stateRootStat,
  enforce = typeof process.getuid === "function",
}) {
  const problems = [];
  if (!enforce) return problems;
  if (!recordStat || recordStat.uid !== 0 || recordStat.gid !== 0) {
    problems.push("the gate record is not owned by root:root");
  }
  if (!recordStat || (recordStat.mode & 0o7777) !== 0o600) {
    problems.push("the gate record mode must be 0600");
  }
  if (!stateRootStat) problems.push("the deploy-state directory is missing");
  else if (stateRootStat.uid !== 0 || (stateRootStat.mode & 0o7777) !== 0o700) {
    problems.push("the deploy-state directory is not root-owned 0700");
  }
  return problems;
}

function parseArgs(argv) {
  const options = {
    record: null,
    expectSha: null,
    stateRoot: DEFAULT_STATE_ROOT,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    nowMs: null,
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
      case "--record":
        options.record = next();
        break;
      case "--expect-sha":
        options.expectSha = next();
        break;
      case "--state-root":
        options.stateRoot = next();
        break;
      case "--max-age-seconds":
        options.maxAgeSeconds = Number(next());
        break;
      case "--now-ms":
        options.nowMs = Number(next());
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Where the record lives and who may have written it. Ownership and mode are
 * enforced wherever the platform reports them (the deploy host is Linux and this
 * runs as root there); the shape checks apply everywhere.
 */
function checkLocation(options) {
  const problems = [];
  const stateRoot = path.resolve(options.stateRoot);
  const record = path.resolve(options.record);
  if (path.dirname(record) !== stateRoot) {
    problems.push(`the gate record must live in ${stateRoot}`);
  }
  if (!RECORD_BASENAME.test(path.basename(record))) {
    problems.push(`${JSON.stringify(path.basename(record))} is not a deploy-gates.* record name`);
  }

  let stat;
  try {
    stat = fs.lstatSync(record);
  } catch {
    // The f37c203 wrapper's outcome: it writes no record, so there is nothing
    // here, so nothing may be installed.
    problems.push("there is no gate record: the deploy wrapper did not record that its gates ran");
    return { problems, stat: null };
  }
  if (stat.isSymbolicLink()) problems.push("the gate record is a symlink");
  else if (!stat.isFile()) problems.push("the gate record is not a regular file");
  let stateRootStat = null;
  if (typeof process.getuid === "function") {
    try {
      stateRootStat = fs.lstatSync(stateRoot);
    } catch {
      stateRootStat = null;
    }
  }
  problems.push(...checkOwnership({ recordStat: stat, stateRootStat }));
  return { problems, stat };
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.record) throw new Error("--record is required");
  if (!options.expectSha) throw new Error("--expect-sha is required");
  if (!Number.isFinite(options.maxAgeSeconds) || options.maxAgeSeconds <= 0) {
    throw new Error("--max-age-seconds must be a positive number");
  }

  const located = checkLocation(options);
  const problems = [...located.problems];
  if (located.stat && located.stat.isFile() && !located.stat.isSymbolicLink()) {
    problems.push(
      ...checkGateRecord({
        text: fs.readFileSync(path.resolve(options.record), "utf8"),
        expectSha: options.expectSha,
        mtimeMs: located.stat.mtimeMs,
        nowMs: options.nowMs ?? Date.now(),
        maxAgeSeconds: options.maxAgeSeconds,
      }),
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`deploy gate record: ${problem}`);
    console.error(`refusing to install the control plane: ${problems.length} problem(s)`);
    return 1;
  }
  console.log(`deploy gate record: ${REQUIRED_GATES.length} required gate(s) accounted for at ${options.expectSha}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`deploy gate record: ${error.message}`);
    process.exit(1);
  }
}
