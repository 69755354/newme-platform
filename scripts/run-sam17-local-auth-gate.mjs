#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "scripts", "verify-local-sam66-auth-regression.mjs");
const REQUIRED_ACTORS = ["boss", "admin", "operator", "sales", "sales-other"];
const REQUIRED_CHECKS = [
  "auth-refresh",
  "dashboard",
  "lead-create-read-update",
  "first-contact",
  "timeline-edit-delete-readback",
  "won-lost",
  "cross-owner-denial",
];

function fail(message) {
  throw new Error(`SAM17_FAIL_CLOSED: ${message}`);
}

function exactStrings(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    fail(`${label} must contain the exact required entries`);
  }
  const sorted = [...actual].sort();
  const wanted = [...expected].sort();
  if (sorted.some((value, index) => value !== wanted[index])) {
    fail(`${label} must contain the exact required entries`);
  }
}

export function validateSam17Report(report, expectedSha) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) fail("expected SHA must be exact");
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("runner report must be an object");
  }
  if (report.ok !== true) fail("runner did not report success");
  if (report.ui !== "covered") fail("browser coverage is required");
  if (!Array.isArray(report.runs) || report.runs.length !== 2) {
    fail("exactly two authenticated runs are required");
  }
  for (const [index, run] of report.runs.entries()) {
    if (run?.run !== index + 1) fail("run sequence is incomplete");
    exactStrings(run.actors, REQUIRED_ACTORS, `run ${index + 1} actors`);
    exactStrings(run.checks, REQUIRED_CHECKS, `run ${index + 1} checks`);
    if (run.cleanup !== "verified") fail(`run ${index + 1} cleanup is not verified`);
  }
  return {
    ok: true,
    git_sha: expectedSha,
    ui: "covered",
    runs: report.runs,
  };
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function evidencePathFor(sha) {
  const requested = process.env.SAM17_EVIDENCE_PATH?.trim();
  const target = requested
    ? path.resolve(requested)
    : path.join(mkdtempSync(path.join(tmpdir(), "newme-sam17-")), `${sha}.json`);
  const root = `${realpathSync(ROOT)}${path.sep}`.toLowerCase();
  if (`${path.resolve(target)}${path.sep}`.toLowerCase().startsWith(root)) {
    fail("evidence path must remain outside the repository");
  }
  return target;
}

function safeError(value) {
  return String(value ?? "unknown failure")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[REDACTED_JWT]")
    .replace(/(password|token|secret|key)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 320);
}

function writeEvidence(target, evidence) {
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function main() {
  const sha = git("rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("HEAD is not an exact commit");
  if (git("status", "--porcelain", "--untracked-files=all")) {
    fail("worktree must be clean before dynamic evidence is collected");
  }
  const evidencePath = evidencePathFor(sha);
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  try {
    if (result.error) throw result.error;
    if (result.status !== 0) {
      fail(`authenticated runner exited ${result.status}: ${safeError(result.stderr)}`);
    }
    const report = JSON.parse(result.stdout.trim());
    const evidence = {
      ...validateSam17Report(report, sha),
      completed_at: new Date().toISOString(),
    };
    writeEvidence(evidencePath, evidence);
    console.log(JSON.stringify({ ok: true, git_sha: sha, evidence_path: evidencePath }));
  } catch (error) {
    writeEvidence(evidencePath, {
      ok: false,
      git_sha: sha,
      completed_at: new Date().toISOString(),
      error: safeError(error instanceof Error ? error.message : error),
    });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(safeError(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
