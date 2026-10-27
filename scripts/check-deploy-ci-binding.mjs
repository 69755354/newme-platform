import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CANONICAL_WORKFLOW = Object.freeze({
  name: "ci",
  path: ".github/workflows/ci.yml",
  id: 310914082,
  event: "workflow_dispatch",
  headBranch: "main",
});

const MAX_ALLOWED_RUN_AGE_SECONDS = 86_400;
const FUTURE_CLOCK_TOLERANCE_MS = 300_000;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseUtc(value, label, findings) {
  if (typeof value !== "string" || !RFC3339_UTC.test(value)) {
    findings.push(`${label} must be a UTC RFC3339 timestamp`);
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    findings.push(`${label} is not a real timestamp`);
    return null;
  }
  return timestamp;
}

export function validateDeployCiBinding({ manifest, env, auditBytes, now = new Date() }) {
  const findings = [];
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) findings.push("validation clock is invalid");

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["required-jobs manifest must be an object"];
  }
  if (manifest.workflow !== CANONICAL_WORKFLOW.name) {
    findings.push("required-jobs manifest workflow is not canonical");
  }
  if (manifest.workflow_path !== CANONICAL_WORKFLOW.path) {
    findings.push("required-jobs manifest workflow path is not canonical");
  }
  if (manifest.workflow_id !== CANONICAL_WORKFLOW.id) {
    findings.push("required-jobs manifest workflow id is not canonical");
  }
  if (manifest.event !== CANONICAL_WORKFLOW.event) {
    findings.push("required-jobs manifest event is not canonical");
  }
  if (manifest.head_branch !== CANONICAL_WORKFLOW.headBranch) {
    findings.push("required-jobs manifest head branch is not canonical");
  }
  if (
    !Number.isInteger(manifest.max_run_age_seconds) ||
    manifest.max_run_age_seconds <= 0 ||
    manifest.max_run_age_seconds > MAX_ALLOWED_RUN_AGE_SECONDS
  ) {
    findings.push("required-jobs manifest run-age limit is invalid or exceeds 24 hours");
  }

  if (env.CI_MAX_RUN_AGE_SECONDS !== String(manifest.max_run_age_seconds)) {
    findings.push("CI run-age limit does not match the exact required-jobs manifest");
  }

  if (env.CI_WORKFLOW_ID !== String(CANONICAL_WORKFLOW.id)) {
    findings.push("CI workflow id does not match the canonical workflow");
  }
  if (env.CI_WORKFLOW_PATH !== CANONICAL_WORKFLOW.path) {
    findings.push("CI workflow path does not match the canonical workflow");
  }
  if (env.CI_EVENT !== CANONICAL_WORKFLOW.event) {
    findings.push("CI event does not match the canonical workflow event");
  }
  if (!SHA256.test(env.CI_GATE_AUDIT_SHA256 ?? "")) {
    findings.push("CI gate audit digest is malformed");
  }

  const completedAt = parseUtc(env.CI_RUN_COMPLETED_AT, "CI run completion", findings);
  const auditedAt = parseUtc(env.CI_GATE_AUDITED_AT, "CI gate audit", findings);
  if (completedAt !== null && auditedAt !== null && completedAt > auditedAt) {
    findings.push("CI gate audit predates the CI run completion");
  }
  let audit = null;
  if (!Buffer.isBuffer(auditBytes) || auditBytes.length === 0 || auditBytes.length > 65_536) {
    findings.push("CI gate audit record is missing or outside the size limit");
  } else {
    if (auditBytes.at(-1) !== 0x0a) findings.push("CI gate audit record must end with one newline");
    if (sha256(auditBytes) !== env.CI_GATE_AUDIT_SHA256) {
      findings.push("CI gate audit record digest does not match the wrapper claim");
    }
    try {
      audit = JSON.parse(auditBytes.toString("utf8"));
    } catch {
      findings.push("CI gate audit record is not JSON");
    }
  }

  const completionTimes = completedAt === null ? [] : [completedAt];
  if (audit && typeof audit === "object" && !Array.isArray(audit)) {
    if (`${canonicalJson(audit)}\n` !== auditBytes.toString("utf8")) {
      findings.push("CI gate audit record is not canonical JSON");
    }
    const expectedManifestDigest = sha256(Buffer.from(canonicalJson(manifest), "utf8"));
    const exactFields = [
      [audit.version, "newme-ci-gate-audit/v1", "version"],
      [audit.release_sha, env.CI_HEAD_SHA, "release SHA"],
      [String(audit.run_id), env.CI_RUN_ID, "run id"],
      [audit.workflow_id, CANONICAL_WORKFLOW.id, "workflow id"],
      [audit.workflow_path, CANONICAL_WORKFLOW.path, "workflow path"],
      [audit.workflow_name, CANONICAL_WORKFLOW.name, "workflow name"],
      [audit.workflow_state, "active", "workflow state"],
      [audit.event, CANONICAL_WORKFLOW.event, "event"],
      [audit.head_branch, CANONICAL_WORKFLOW.headBranch, "head branch"],
      [audit.run_status, "completed", "run status"],
      [audit.run_conclusion, "success", "run conclusion"],
      [audit.max_run_age_seconds, manifest.max_run_age_seconds, "run-age limit"],
      [audit.run_completed_at, env.CI_RUN_COMPLETED_AT, "run completion"],
      [audit.validated_at, env.CI_GATE_AUDITED_AT, "validation time"],
      [audit.manifest_sha256, expectedManifestDigest, "manifest digest"],
    ];
    for (const [actual, expected, label] of exactFields) {
      if (actual !== expected) findings.push(`CI gate audit ${label} does not match the release claim`);
    }

    const createdAt = parseUtc(audit.run_created_at, "CI audit run creation", findings);
    const startedAt = parseUtc(audit.run_started_at, "CI audit run start", findings);
    const auditCompletedAt = parseUtc(audit.run_completed_at, "CI audit run completion", findings);
    if (
      createdAt !== null && startedAt !== null && auditCompletedAt !== null &&
      !(createdAt <= startedAt && startedAt <= auditCompletedAt)
    ) {
      findings.push("CI gate audit run timestamps are unordered");
    }

    const expectedJobs = manifest.required_jobs?.map((entry) => entry?.name).sort();
    const completedJobs = audit.required_job_completed_at;
    if (
      !Array.isArray(expectedJobs) || expectedJobs.length === 0 ||
      !completedJobs || typeof completedJobs !== "object" || Array.isArray(completedJobs) ||
      JSON.stringify(Object.keys(completedJobs).sort()) !== JSON.stringify(expectedJobs)
    ) {
      findings.push("CI gate audit required-job completion set is not exact");
    } else {
      for (const [name, value] of Object.entries(completedJobs)) {
        const jobTime = parseUtc(value, `CI audit required job ${JSON.stringify(name)}`, findings);
        if (jobTime !== null) {
          completionTimes.push(jobTime);
          if (createdAt !== null && jobTime < createdAt) {
            findings.push(`CI audit required job ${JSON.stringify(name)} predates the run`);
          }
          if (auditCompletedAt !== null && jobTime > auditCompletedAt) {
            findings.push(`CI audit required job ${JSON.stringify(name)} completed after the run`);
          }
        }
      }
    }
  } else if (audit !== null) {
    findings.push("CI gate audit record must contain an object");
  }

  if (Number.isFinite(nowMs)) {
    if (completedAt !== null && completedAt > nowMs + FUTURE_CLOCK_TOLERANCE_MS) {
      findings.push("CI run completion is in the future");
    }
    if (auditedAt !== null && auditedAt > nowMs + FUTURE_CLOCK_TOLERANCE_MS) {
      findings.push("CI gate audit is in the future");
    }
    const oldestCompletion = completionTimes.length > 0 ? Math.min(...completionTimes) : null;
    if (oldestCompletion !== null && nowMs - oldestCompletion > manifest.max_run_age_seconds * 1000) {
      findings.push("CI run is stale at the current release boundary");
    }
  }

  return findings;
}

function parseArgs(argv) {
  if (
    argv.length !== 4 || argv[0] !== "--manifest" || !argv[1] ||
    argv[2] !== "--audit-record" || !argv[3]
  ) {
    throw new Error("usage: check-deploy-ci-binding.mjs --manifest <required-jobs.json> --audit-record <ci-gate-audit.json>");
  }
  return { manifestPath: argv[1], auditPath: argv[3] };
}

function main() {
  let manifest;
  let auditBytes;
  try {
    const { manifestPath, auditPath } = parseArgs(process.argv.slice(2));
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const metadata = lstatSync(auditPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("CI gate audit record is not a regular file");
    if (process.platform !== "win32" && (metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o777) !== 0o600)) {
      throw new Error("CI gate audit record ownership or mode is invalid");
    }
    auditBytes = readFileSync(auditPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 64;
  }
  const findings = validateDeployCiBinding({ manifest, env: process.env, auditBytes });
  if (findings.length > 0) {
    for (const finding of findings) console.error(`[FAIL] ${finding}`);
    return 65;
  }
  console.log("CI_GATE_BINDING=PASS");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
