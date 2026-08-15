#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = Object.freeze({
  name: "ci",
  path: ".github/workflows/ci.yml",
  id: 310914082,
  event: "workflow_dispatch",
  branch: "main",
});
const SHA = /^[0-9a-f]{40}$/;
const RUN = /^[1-9][0-9]{0,19}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FUTURE_TOLERANCE_MS = 300_000;
export const REQUIRED_CREDENTIAL_REMEDIATION_JOBS = Object.freeze([
  "Repository validation",
  "CodeQL analysis",
  "Windows checkout and SPEC gate",
  "Credential remediation readiness",
  "Control-plane restore interruption drill",
  "Narrow task follow-up database contract",
  "Migration replay and release contracts",
]);
export const REQUIRED_SKIPPED_CREDENTIAL_REMEDIATION_JOBS = Object.freeze([
  "Predeploy taskboard readiness",
  "Release-final taskboard completion",
]);

function timestamp(value, label, findings) {
  if (typeof value !== "string" || !UTC.test(value)) {
    findings.push(`${label} is not a UTC RFC3339 timestamp`);
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    findings.push(`${label} is not a real timestamp`);
    return null;
  }
  return parsed;
}

function names(entries, label, findings) {
  if (!Array.isArray(entries) || entries.length === 0) {
    findings.push(`${label} is empty`);
    return [];
  }
  const result = entries.map((entry) => entry?.name);
  if (result.some((name) => typeof name !== "string" || name.length === 0)) {
    findings.push(`${label} contains an unnamed job`);
  }
  if (new Set(result).size !== result.length) findings.push(`${label} contains a duplicate job`);
  return result;
}

export function validateCredentialRemediationCi({
  manifest,
  run,
  jobsResponse,
  workflow,
  expectedSha,
  expectedRun,
  expectedAttempt,
  now = new Date(),
}) {
  const findings = [];
  if (!SHA.test(String(expectedSha ?? ""))) findings.push("expected SHA is invalid");
  if (!RUN.test(String(expectedRun ?? ""))) findings.push("expected run id is invalid");
  if (!Number.isInteger(expectedAttempt) || expectedAttempt < 1) findings.push("expected run attempt is invalid");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["credential-remediation manifest must be an object"];
  }
  const exactManifest = [
    [manifest.workflow, WORKFLOW.name, "workflow name"],
    [manifest.workflow_path, WORKFLOW.path, "workflow path"],
    [manifest.workflow_id, WORKFLOW.id, "workflow id"],
    [manifest.event, WORKFLOW.event, "event"],
    [manifest.head_branch, WORKFLOW.branch, "head branch"],
  ];
  for (const [actual, expected, label] of exactManifest) {
    if (actual !== expected) findings.push(`manifest ${label} is not canonical`);
  }
  if (
    !Number.isInteger(manifest.max_run_age_seconds) ||
    manifest.max_run_age_seconds <= 0 ||
    manifest.max_run_age_seconds > 21_600
  ) {
    findings.push("manifest freshness window is invalid or exceeds six hours");
  }
  if (JSON.stringify(manifest.tolerated_conclusions) !== JSON.stringify(["success"])) {
    findings.push("manifest tolerates a conclusion other than success");
  }
  const required = names(manifest.required_jobs, "required_jobs", findings);
  const skipped = names(manifest.required_skipped_jobs, "required_skipped_jobs", findings);
  if (JSON.stringify(required) !== JSON.stringify(REQUIRED_CREDENTIAL_REMEDIATION_JOBS)) {
    findings.push("required_jobs is not the exact canonical credential-remediation set");
  }
  if (JSON.stringify(skipped) !== JSON.stringify(REQUIRED_SKIPPED_CREDENTIAL_REMEDIATION_JOBS)) {
    findings.push("required_skipped_jobs is not the exact canonical credential-remediation set");
  }
  if (required.some((name) => skipped.includes(name))) findings.push("required and skipped job sets overlap");

  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    findings.push("workflow endpoint payload is not an object");
  } else {
    const fields = [
      [workflow.id, WORKFLOW.id, "id"],
      [workflow.name, WORKFLOW.name, "name"],
      [workflow.path, WORKFLOW.path, "path"],
      [workflow.state, "active", "state"],
    ];
    for (const [actual, expected, label] of fields) {
      if (actual !== expected) findings.push(`workflow ${label} is not canonical`);
    }
  }

  if (!run || typeof run !== "object" || Array.isArray(run)) {
    findings.push("run payload is not an object");
  } else {
    const fields = [
      [String(run.id), String(expectedRun), "id"],
      [run.run_attempt, expectedAttempt, "attempt"],
      [run.head_sha, expectedSha, "head SHA"],
      [run.name, WORKFLOW.name, "name"],
      [run.path, WORKFLOW.path, "path"],
      [run.workflow_id, WORKFLOW.id, "workflow id"],
      [run.event, WORKFLOW.event, "event"],
      [run.head_branch, WORKFLOW.branch, "head branch"],
      [run.status, "completed", "status"],
      [run.conclusion, "success", "conclusion"],
    ];
    for (const [actual, expected, label] of fields) {
      if (actual !== expected) findings.push(`run ${label} does not match the credential-remediation claim`);
    }
  }

  const createdAt = timestamp(run?.created_at, "run created_at", findings);
  const startedAt = timestamp(run?.run_started_at, "run run_started_at", findings);
  const completedAt = timestamp(run?.updated_at, "run updated_at", findings);
  if (createdAt !== null && startedAt !== null && completedAt !== null && !(createdAt <= startedAt && startedAt <= completedAt)) {
    findings.push("run timestamps are unordered");
  }

  const jobs = jobsResponse?.jobs;
  if (!Array.isArray(jobs)) {
    findings.push("jobs endpoint payload is not an array");
  } else {
    if (jobsResponse.total_count !== jobs.length) findings.push("jobs response is paginated");
    const byName = new Map();
    for (const job of jobs) {
      if (typeof job?.name !== "string" || job.name.length === 0) {
        findings.push("a job is unnamed");
        continue;
      }
      if (byName.has(job.name)) findings.push(`job ${JSON.stringify(job.name)} appears twice`);
      byName.set(job.name, job);
      if (job.head_sha !== undefined && job.head_sha !== null && job.head_sha !== expectedSha) {
        findings.push(`job ${JSON.stringify(job.name)} belongs to another SHA`);
      }
      if (job.status !== "completed" || !["success", "skipped"].includes(job.conclusion)) {
        findings.push(`job ${JSON.stringify(job.name)} concluded ${JSON.stringify(job.conclusion)}`);
      }
    }
    for (const name of required) {
      const job = byName.get(name);
      if (!job) {
        findings.push(`required job ${JSON.stringify(name)} is absent`);
        continue;
      }
      if (job.status !== "completed" || job.conclusion !== "success") {
        findings.push(`required job ${JSON.stringify(name)} is not completed success`);
      }
      const jobStarted = timestamp(job.started_at, `required job ${JSON.stringify(name)} started_at`, findings);
      const jobCompleted = timestamp(job.completed_at, `required job ${JSON.stringify(name)} completed_at`, findings);
      if (jobStarted !== null && jobCompleted !== null && jobStarted > jobCompleted) {
        findings.push(`required job ${JSON.stringify(name)} timestamps are unordered`);
      }
      if (startedAt !== null && jobStarted !== null && jobStarted < startedAt) {
        findings.push(`required job ${JSON.stringify(name)} started before the run`);
      }
      if (completedAt !== null && jobCompleted !== null && jobCompleted > completedAt) {
        findings.push(`required job ${JSON.stringify(name)} completed after the run`);
      }
    }
    for (const name of skipped) {
      const job = byName.get(name);
      if (!job) findings.push(`required-skipped job ${JSON.stringify(name)} is absent`);
      else if (job.status !== "completed" || job.conclusion !== "skipped") {
        findings.push(`required-skipped job ${JSON.stringify(name)} is not completed skipped`);
      }
    }
  }

  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) findings.push("validation clock is invalid");
  if (Number.isFinite(nowMs) && startedAt !== null) {
    if (startedAt > nowMs + FUTURE_TOLERANCE_MS) findings.push("run start is in the future");
    if (nowMs - startedAt > manifest.max_run_age_seconds * 1000) findings.push("credential-remediation run is stale");
  }
  return findings;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("credential CI verifier arguments must be --key value pairs");
    options[key.slice(2)] = value;
  }
  for (const required of ["manifest", "run-json", "jobs-json", "workflow-json", "expect-sha", "expect-run", "expect-attempt"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

function readJsonFile(file, label) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 2_000_000) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function main(argv) {
  const options = parseArgs(argv);
  const manifest = readJsonFile(options.manifest, "manifest");
  const run = readJsonFile(options["run-json"], "run payload");
  const jobsResponse = readJsonFile(options["jobs-json"], "jobs payload");
  const workflow = readJsonFile(options["workflow-json"], "workflow payload");
  const findings = validateCredentialRemediationCi({
    manifest,
    run,
    jobsResponse,
    workflow,
    expectedSha: options["expect-sha"],
    expectedRun: options["expect-run"],
    expectedAttempt: Number(options["expect-attempt"]),
  });
  if (findings.length > 0) {
    for (const finding of findings) console.error(`credential remediation CI: ${finding}`);
    return 65;
  }
  process.stdout.write(`credential_ci=verified run_attempt=${run.run_attempt} run_started_at=${run.run_started_at} max_age_seconds=${manifest.max_run_age_seconds}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`credential remediation CI: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 64;
  }
}
