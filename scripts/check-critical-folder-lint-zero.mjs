#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CRITICAL_LINT_ZERO_SCOPES = [
  "src/app/api/cos/download-url",
  "src/app/api/cron/check-alerts",
  "src/app/api/contracts/list",
  "src/app/api/notifications/unread-count",
  "src/app/api/notifications/read-all",
  "src/app/api/notifications/[id]",
  "src/app/api/cron/daily-reminder",
  "src/app/api/activity/daily-report",
];

export function checkCriticalFolderLintZero({
  root = process.cwd(),
  run = spawnSync,
  exists = fs.existsSync,
  log = console.log,
  error = console.error,
} = {}) {
  const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");

  for (const scope of CRITICAL_LINT_ZERO_SCOPES) {
    const scopePath = path.join(root, ...scope.split("/"));
    if (!exists(scopePath)) {
      throw new Error(`locked lint-zero scope is missing: ${scope}`);
    }
  }
  if (!exists(eslintBin)) {
    throw new Error(`project-local ESLint is missing: ${path.relative(root, eslintBin)}`);
  }

  const result = run(
    process.execPath,
    [eslintBin, ...CRITICAL_LINT_ZERO_SCOPES, "--format", "json", "--max-warnings", "0"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`ESLint could not start: ${result.error.message}`);
  }
  if (result.status === null || result.status === undefined || result.signal) {
    throw new Error(`ESLint terminated unexpectedly: ${result.signal ?? "unknown status"}`);
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (!stdout.trim()) {
    throw new Error(
      `ESLint produced no JSON output (exit ${result.status}): ${stderr.trim() || "no stderr"}`,
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `ESLint failed before linting (exit ${result.status}): ${stderr.trim() || "no stderr"}`,
    );
  }

  let reports;
  try {
    reports = JSON.parse(stdout);
  } catch (parseError) {
    throw new Error(`ESLint produced invalid JSON: ${parseError.message}`);
  }
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error("ESLint JSON must contain reports for the locked scopes");
  }
  for (const scope of CRITICAL_LINT_ZERO_SCOPES) {
    const scopePath = path.resolve(root, ...scope.split("/"));
    const hasReport = reports.some((report) => {
      if (typeof report?.filePath !== "string") return false;
      const reportPath = path.resolve(root, report.filePath);
      return reportPath === scopePath || reportPath.startsWith(`${scopePath}${path.sep}`);
    });
    if (!hasReport) {
      throw new Error(`ESLint returned no report for locked scope: ${scope}`);
    }
  }

  const errors = reports.reduce((total, report) => total + Number(report.errorCount ?? 0), 0);
  const warnings = reports.reduce((total, report) => total + Number(report.warningCount ?? 0), 0);
  if (!Number.isSafeInteger(errors) || !Number.isSafeInteger(warnings) || errors < 0 || warnings < 0) {
    throw new Error("ESLint JSON contains invalid finding counts");
  }

  if (errors !== 0 || warnings !== 0) {
    error(
      `Critical-folder lint-zero gate failed: locked scopes have ${errors} error(s) and ${warnings} warning(s).`,
    );
    return { exitCode: 1, errors, warnings };
  }
  if (result.status !== 0) {
    throw new Error(`ESLint exited ${result.status} despite reporting zero findings`);
  }

  log(
    `Critical-folder lint-zero gate passed: ${CRITICAL_LINT_ZERO_SCOPES.length} scopes have 0 errors and 0 warnings.`,
  );
  return { exitCode: 0, errors: 0, warnings: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = checkCriticalFolderLintZero().exitCode;
  } catch (checkError) {
    console.error(`Critical-folder lint-zero gate failed closed: ${checkError.message}`);
    process.exitCode = 1;
  }
}
