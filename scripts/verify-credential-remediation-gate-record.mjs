/**
 * Verify the one-use, root-owned handoff from the protected credential
 * remediation coordinator to the credential-only asset installer.
 *
 * The record contains no credential material. It proves only that the exact
 * canonical-main SHA, its dedicated workflow run, and the narrow taskboard mode
 * were re-measured before this installer invocation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_CREDENTIAL_GATES = Object.freeze([
  "canonical-main-verified",
  "github-credential-remediation-jobs-green",
  "taskboard-credential-remediation-ready",
  "credential-assets-only",
]);

export const DEFAULT_STATE_ROOT = "/var/lib/newme/deploy-state";
export const DEFAULT_MAX_AGE_SECONDS = 900;
const FUTURE_TOLERANCE_MS = 60_000;
const RECORD_BASENAME = /^credential-remediation-gates\.[A-Za-z0-9]{6,}$/;

export function checkCredentialGateRecord({
  text,
  expectSha,
  expectAttempt,
  mtimeMs,
  nowMs,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
}) {
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(String(expectSha ?? ""))) {
    problems.push("the expected remediation SHA is not a 40-character hex commit id");
  }
  if (!Number.isInteger(expectAttempt) || expectAttempt < 1) {
    problems.push("the expected remediation run attempt is invalid");
  }

  const values = new Map();
  const gates = [];
  for (const line of String(text ?? "").split(/\r?\n/).filter(Boolean)) {
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
    if (!["sha", "event", "run", "run_attempt", "mode"].includes(key)) {
      problems.push(`the gate record has an unknown key ${JSON.stringify(key)}`);
      continue;
    }
    if (values.has(key)) problems.push(`the gate record sets ${key} twice`);
    values.set(key, value);
  }

  if (values.get("sha") !== expectSha) problems.push("the gate record is for a different remediation SHA");
  if (values.get("event") !== "workflow_dispatch") problems.push("the remediation evidence is not a workflow_dispatch run");
  if (!/^[1-9][0-9]{0,19}$/.test(String(values.get("run") ?? ""))) {
    problems.push("the gate record does not name a valid GitHub Actions run");
  }
  if (values.get("run_attempt") !== String(expectAttempt)) {
    problems.push("the gate record is for a different GitHub Actions run attempt");
  }
  if (values.get("mode") !== "credential_remediation") {
    problems.push("the gate record is not scoped to credential remediation");
  }

  const missing = REQUIRED_CREDENTIAL_GATES.filter((gate) => !gates.includes(gate));
  const unknown = gates.filter((gate) => !REQUIRED_CREDENTIAL_GATES.includes(gate));
  if (missing.length > 0) problems.push(`the gate record does not account for: ${missing.join(", ")}`);
  if (unknown.length > 0) problems.push(`the gate record claims unknown gates: ${unknown.join(", ")}`);

  const ageMs = nowMs - mtimeMs;
  if (ageMs > maxAgeSeconds * 1000) problems.push("the credential-remediation gate record is stale");
  if (ageMs < -FUTURE_TOLERANCE_MS) problems.push("the credential-remediation gate record is dated in the future");
  return problems;
}

function parseArgs(argv) {
  const options = {
    record: null,
    expectSha: null,
    expectAttempt: null,
    stateRoot: DEFAULT_STATE_ROOT,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    nowMs: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case "--record": options.record = next(); break;
      case "--expect-sha": options.expectSha = next(); break;
      case "--expect-attempt": options.expectAttempt = Number(next()); break;
      case "--state-root": options.stateRoot = next(); break;
      case "--max-age-seconds": options.maxAgeSeconds = Number(next()); break;
      case "--now-ms": options.nowMs = Number(next()); break;
      default: throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function checkLocation(options) {
  const problems = [];
  const stateRoot = path.resolve(options.stateRoot);
  const record = path.resolve(options.record);
  if (path.dirname(record) !== stateRoot) problems.push(`the gate record must live in ${stateRoot}`);
  if (!RECORD_BASENAME.test(path.basename(record))) problems.push("the gate record name is not credential-remediation-gates.*");

  let recordStat = null;
  let stateRootStat = null;
  try { recordStat = fs.lstatSync(record); } catch { problems.push("the credential-remediation gate record is missing"); }
  try { stateRootStat = fs.lstatSync(stateRoot); } catch { problems.push("the deploy-state directory is missing"); }
  if (recordStat) {
    if (recordStat.isSymbolicLink() || !recordStat.isFile()) problems.push("the gate record is not a regular non-symlink file");
    if (typeof process.getuid === "function" && (recordStat.uid !== 0 || recordStat.gid !== 0 || (recordStat.mode & 0o7777) !== 0o600)) {
      problems.push("the gate record must be root:root mode 0600");
    }
  }
  if (stateRootStat && typeof process.getuid === "function") {
    if (stateRootStat.isSymbolicLink() || !stateRootStat.isDirectory() || stateRootStat.uid !== 0 || stateRootStat.gid !== 0 || (stateRootStat.mode & 0o7777) !== 0o700) {
      problems.push("the deploy-state directory must be root:root mode 0700");
    }
  }
  return { problems, recordStat, record };
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.record || !options.expectSha || !Number.isInteger(options.expectAttempt) || options.expectAttempt < 1) {
    throw new Error("--record, --expect-sha, and --expect-attempt are required");
  }
  if (!Number.isFinite(options.maxAgeSeconds) || options.maxAgeSeconds <= 0) throw new Error("--max-age-seconds must be positive");
  const located = checkLocation(options);
  const problems = [...located.problems];
  if (located.recordStat?.isFile() && !located.recordStat.isSymbolicLink()) {
    problems.push(...checkCredentialGateRecord({
      text: fs.readFileSync(located.record, "utf8"),
      expectSha: options.expectSha,
      expectAttempt: options.expectAttempt,
      mtimeMs: located.recordStat.mtimeMs,
      nowMs: options.nowMs ?? Date.now(),
      maxAgeSeconds: options.maxAgeSeconds,
    }));
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`credential remediation gate record: ${problem}`);
    return 1;
  }
  console.log(`credential remediation gate record: ${REQUIRED_CREDENTIAL_GATES.length} required gate(s) accounted for`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`credential remediation gate record: ${error.message}`);
    process.exit(1);
  }
}
