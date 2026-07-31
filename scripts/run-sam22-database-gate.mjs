#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const PASSWORD = "sam22-disposable-only";

function command(args, options = {}) {
  return spawnSync(process.env.SAM22_DOCKER_BIN || "docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 180_000,
    ...options,
  });
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label}_failed:${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`,
    );
  }
}

function psql(container, args, environmentName) {
  const env = ["-e", `PGPASSWORD=${PASSWORD}`];
  if (environmentName) {
    env.push("-e", `PGOPTIONS=-cnewme.environment=${environmentName}`);
  }
  return command([
    "exec",
    ...env,
    "-w",
    "/work/tests/database",
    container,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "sam22",
    ...args,
  ]);
}

async function main() {
  const container = `newme-sam22-db-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    requireSuccess(command([
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--env",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "--env",
      "POSTGRES_DB=sam22",
      POSTGRES_IMAGE,
    ]), "sam22_postgres_start");
    started = true;

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = command([
        "exec",
        container,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "sam22",
      ], { timeout: 10_000 });
      if (!result.error && result.status === 0) {
        ready = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!ready) throw new Error("sam22_postgres_not_ready");

    for (const relativePath of [
      "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
      "supabase/migrations/20260730110000_sam22_two_organization_isolation.sql",
      "supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql",
      "tests/database/sam20-lead-organization-isolation.sql",
      "tests/database/sam22-two-organization-isolation.sql",
      "tests/database/sam22-two-organization-rollback-verify.sql",
    ]) {
      const destination = `/work/${relativePath.replaceAll("\\", "/")}`;
      const parent = destination.slice(0, destination.lastIndexOf("/"));
      requireSuccess(command(["exec", container, "mkdir", "-p", parent]), "sam22_mkdir");
      requireSuccess(command(["cp", resolve(ROOT, relativePath), `${container}:${destination}`]), "sam22_copy");
    }

    requireSuccess(
      psql(container, ["-f", "sam22-two-organization-isolation.sql"]),
      "sam22_apply_harness",
    );

    const deniedRollback = psql(
      container,
      ["-f", "/work/supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql"],
    );
    if (
      deniedRollback.status === 0
      || !`${deniedRollback.stdout}${deniedRollback.stderr}`.includes(
        "sam22_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("sam22_rollback_fail_closed_contract_failed");
    }

    const stillApplied = psql(container, [
      "-A",
      "-t",
      "-q",
      "-c",
      `SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='crm_daily_funnel_snapshot'
         AND column_name='organization_id'`,
    ]);
    requireSuccess(stillApplied, "sam22_failed_rollback_atomicity");
    if (stillApplied.stdout.trim() !== "1") {
      throw new Error("sam22_failed_rollback_changed_schema");
    }

    requireSuccess(
      psql(
        container,
        ["-f", "/work/supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql"],
        "test",
      ),
      "sam22_rollback",
    );
    requireSuccess(
      psql(container, ["-f", "sam22-two-organization-rollback-verify.sql"]),
      "sam22_rollback_verify",
    );

    process.stdout.write(`${JSON.stringify({
      status: "passed",
      image: POSTGRES_IMAGE,
      apply: "verified",
      org_a_b_rls: "verified",
      import_uniqueness: "verified",
      rollback_fail_closed: "verified",
      rollback: "verified",
      fixture_cleanup: "verified",
    })}\n`);
  } finally {
    if (started) {
      const cleanup = command(["rm", "--force", container]);
      if (cleanup.error || cleanup.status !== 0) {
        process.stderr.write("sam22_disposable_cleanup_failed\n");
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
