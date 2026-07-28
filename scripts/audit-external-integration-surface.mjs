#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CHECKS = [
  {
    id: "health-minimal-response",
    file: "src/app/api/health/route.ts",
    patterns: ["status: \"ok\"", "service: \"newme-crm\"", "version:", "Cache-Control", "no-store"],
    forbidden: ["SUPABASE_SERVICE_ROLE_KEY", "process.memoryUsage", "error:"],
  },
  {
    id: "readiness-token-and-timeout",
    file: "src/app/api/ready/route.ts",
    patterns: ["NEWME_READINESS_TOKEN", "AbortController", "controller.abort()", "status: \"degraded\""],
  },
  {
    id: "monitoring-shared-secret",
    file: "src/app/api/monitoring/report/route.ts",
    patterns: ["x-monitoring-secret", "MONITORING_SECRET", "status: 401"],
  },
  {
    id: "meta-oauth-state",
    file: "src/app/api/meta/oauth-start/route.ts",
    patterns: ["randomBytes(32)", "meta_oauth_state", "httpOnly: true", "secure: true"],
  },
  {
    id: "authenticated-notification-trigger",
    file: "src/app/api/notify/route.ts",
    patterns: ["createServerSupabase", "supabase.auth.getUser", "Unauthorized"],
  },
  {
    id: "cron-route-guards",
    files: [
      "src/app/api/cron/check-alerts/route.ts",
      "src/app/api/cron/check-no-answer/route.ts",
      "src/app/api/cron/check-overdue-followups/route.ts",
      "src/app/api/cron/check-overdue-installments/route.ts",
      "src/app/api/cron/cleanup-notifications/route.ts",
      "src/app/api/cron/daily-funnel-snapshot/route.ts",
      "src/app/api/cron/daily-reminder/route.ts",
    ],
    anyOfPatterns: ["CRON_SECRET", "DISABLED"],
  },
];

async function readSource(root, relativePath) {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch {
    return null;
  }
}

async function evaluateCheck(root, check) {
  const files = check.files ?? [check.file];
  const sources = await Promise.all(files.map((file) => readSource(root, file)));
  const combined = sources.filter((source) => typeof source === "string").join("\n");
  const missing = [];

  if (sources.some((source) => source === null)) missing.push("required-source-file");
  for (const pattern of check.patterns ?? []) {
    if (!combined.includes(pattern)) missing.push(pattern);
  }
  if ((check.anyOfPatterns ?? []).length > 0 && !sources.every((source) =>
    typeof source === "string" && check.anyOfPatterns.some((pattern) => source.includes(pattern)),
  )) {
    missing.push("per-route-guard");
  }
  for (const pattern of check.forbidden ?? []) {
    if (combined.includes(pattern)) missing.push("forbidden-surface");
  }

  return missing.length === 0
    ? { id: check.id, status: "pass" }
    : { id: check.id, status: "fail", missing: [...new Set(missing)] };
}

/**
 * Inspects tracked source only. It makes no HTTP request, reads no environment
 * variable or secret file, and returns identifiers rather than source content.
 */
export async function auditExternalIntegrationSurface(root, { checks = DEFAULT_CHECKS } = {}) {
  const results = [];
  for (const check of checks) results.push(await evaluateCheck(root, check));
  return {
    mode: "offline",
    ok: results.every((check) => check.status === "pass"),
    checks: results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await auditExternalIntegrationSurface(process.cwd());
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
