#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const password = "sam83-disposable-only";
const database = "sam83";
const migrations = [
  "20260805120000_sam82_retail_catalog_inventory_pricing.sql",
  "20260805130000_sam83_retail_order_procurement_fulfillment_finance.sql",
];
const rollbacks = [
  "20260805130000_sam83_retail_order_procurement_fulfillment_finance_rollback.sql",
  "20260805120000_sam82_retail_catalog_inventory_pricing_rollback.sql",
];

function command(args, options = {}) {
  const result = spawnSync(process.env.SAM83_DOCKER_BIN || "docker", args, { cwd: root, encoding: "utf8", timeout: 240_000, ...options });
  return { ...result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}
function requireSuccess(result, label) {
  if (result.error || result.status !== 0) throw new Error(`${label}_failed:${result.output || result.error?.message || "unknown"}`);
}
function psql(container, args, label, environmentName) {
  const environment = ["-e", `PGPASSWORD=${password}`];
  if (environmentName) environment.push("-e", `PGOPTIONS=-cnewme.environment=${environmentName}`);
  const result = command(["exec", ...environment, "-w", "/work/tests/database", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, ...args]);
  requireSuccess(result, label);
  return result;
}
function copy(container, source) {
  const target = `/work/${source.replaceAll("\\", "/")}`;
  requireSuccess(command(["exec", container, "mkdir", "-p", target.slice(0, target.lastIndexOf("/"))]), `sam83_mkdir_${source}`);
  requireSuccess(command(["cp", resolve(root, source), `${container}:${target}`]), `sam83_copy_${source}`);
}

async function main() {
  const container = `newme-sam83-db-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    requireSuccess(command(["run", "--detach", "--rm", "--name", container, "--env", `POSTGRES_PASSWORD=${password}`, "--env", `POSTGRES_DB=${database}`, image]), "sam83_postgres_start");
    started = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = command(["exec", container, "pg_isready", "-U", "postgres", "-d", database]);
      if (!ready.error && ready.status === 0) break;
      if (attempt === 59) throw new Error("sam83_postgres_not_ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    for (const source of [
      ...migrations.map((file) => `supabase/migrations/${file}`),
      ...rollbacks.map((file) => `supabase/rollback/${file}`),
      "tests/database/sam83-retail-operations.sql",
    ]) copy(container, source);
    psql(container, ["-f", "sam83-retail-operations.sql"], "sam83_apply_and_contract");

    const denied = command(["exec", "-e", `PGPASSWORD=${password}`, "-w", "/work/tests/database", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-f", `/work/supabase/rollback/${rollbacks[0]}`]);
    if (!denied.error && denied.status === 0) throw new Error("sam83_rollback_outside_test_allowed");
    if (!denied.output.includes("sam83_rollback_requires_staging_or_test")) throw new Error(`sam83_rollback_wrong_failure:${denied.output || "unknown"}`);
    psql(container, ["-f", `/work/supabase/rollback/${rollbacks[0]}`], "sam83_rollback", "test");
    psql(container, ["-f", `/work/supabase/rollback/${rollbacks[1]}`], "sam82_rollback", "test");
    const residue = psql(container, ["-A", "-t", "-q", "-c", "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'retail_%'"], "sam83_rollback_residue").stdout.trim();
    if (residue !== "0") throw new Error(`sam83_rollback_residue:${residue}`);
    const capabilities = psql(container, ["-A", "-t", "-q", "-c", "SELECT count(*) FROM public.capabilities WHERE capability_key LIKE 'retail.%'"], "sam83_rollback_capability_residue").stdout.trim();
    if (capabilities !== "0") throw new Error(`sam83_rollback_capability_residue:${capabilities}`);
    process.stdout.write(`${JSON.stringify({ status: "passed", image, order_conversion: "verified", procurement_receipt: "verified", fulfillment: "verified", cod_separation: "verified", finance_reconciliation: "verified", rls_acl: "verified", rollback_fail_closed: "verified", rollback: "verified", cleanup: "verified" })}\n`);
  } finally {
    if (started) {
      const cleanup = command(["rm", "--force", container]);
      if (cleanup.error || cleanup.status !== 0) { process.stderr.write(`sam83_disposable_cleanup_failed:${cleanup.output || cleanup.error?.message || "unknown"}\n`); process.exitCode = 1; }
    }
  }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
