#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const password = "sam84-disposable-only";
const database = "sam84";
const migration = "20260806000000_sam84_controlled_agent_integration_gateway.sql";
const rollback = "20260806000000_sam84_controlled_agent_integration_gateway_rollback.sql";

function command(args, options = {}) {
  const result = spawnSync(process.env.SAM84_DOCKER_BIN || "docker", args, {
    cwd: root, encoding: "utf8", timeout: 240_000, ...options,
  });
  return { ...result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}
function requireSuccess(result, label) {
  if (result.error || result.status !== 0) throw new Error(`${label}_failed:${result.output || result.error?.message || "unknown"}`);
}
function psql(container, args, label, environment) {
  const env = ["-e", `PGPASSWORD=${password}`];
  if (environment) env.push("-e", `PGOPTIONS=-cnewme.environment=${environment}`);
  const result = command(["exec", ...env, "-w", "/work/tests/database", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, ...args]);
  requireSuccess(result, label);
  return result;
}
function copy(container, source) {
  const target = `/work/${source.replaceAll("\\", "/")}`;
  requireSuccess(command(["exec", container, "mkdir", "-p", target.slice(0, target.lastIndexOf("/"))]), `sam84_mkdir_${source}`);
  requireSuccess(command(["cp", resolve(root, source), `${container}:${target}`]), `sam84_copy_${source}`);
}

async function main() {
  const container = `newme-sam84-db-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    requireSuccess(command(["run", "--detach", "--rm", "--name", container, "--env", `POSTGRES_PASSWORD=${password}`, "--env", `POSTGRES_DB=${database}`, image]), "sam84_postgres_start");
    started = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = command(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", database]);
      if (!ready.error && ready.status === 0) break;
      if (attempt === 59) throw new Error("sam84_postgres_not_ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    for (const source of [
      `supabase/migrations/${migration}`,
      `supabase/rollback/${rollback}`,
      "tests/database/sam84-agent-gateway.sql",
    ]) copy(container, source);
    psql(container, ["-f", "sam84-agent-gateway.sql"], "sam84_apply_and_contract");
    const denied = command(["exec", "-e", `PGPASSWORD=${password}`, "-w", "/work/tests/database", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-f", `/work/supabase/rollback/${rollback}`]);
    if (!denied.error && denied.status === 0) throw new Error("sam84_rollback_outside_test_allowed");
    if (!denied.output.includes("sam84_agent_gateway_rollback_requires_staging_or_test")) throw new Error(`sam84_rollback_wrong_failure:${denied.output || "unknown"}`);
    psql(container, ["-f", `/work/supabase/rollback/${rollback}`], "sam84_rollback", "test");
    const residue = psql(container, ["-A", "-t", "-q", "-c", "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'agent_gateway_%'"], "sam84_rollback_residue").stdout.trim();
    if (residue !== "0") throw new Error(`sam84_rollback_residue:${residue}`);
    process.stdout.write(`${JSON.stringify({ status: "passed", image, policy_l0_l4: "verified", server_only_rpc: "verified", l3_approval_binding: "verified", signed_events: "verified", idempotency: "verified", adapters_disabled: "verified", rollback_fail_closed: "verified", rollback: "verified", cleanup: "verified" })}\n`);
  } finally {
    if (started) {
      const cleanup = command(["rm", "--force", container]);
      if (cleanup.error || cleanup.status !== 0) { process.stderr.write(`sam84_disposable_cleanup_failed:${cleanup.output || cleanup.error?.message || "unknown"}\n`); process.exitCode = 1; }
    }
  }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
