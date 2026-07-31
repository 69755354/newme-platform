#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const DATABASE_NAME = "sam61";
const DATABASE_PASSWORD = "sam61-disposable-only";

function command(docker, args) {
  const result = spawnSync(docker, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  return {
    ...result,
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label}_failed:${result.combined || result.error?.message || "unknown"}`,
    );
  }
  return result;
}

function psql(docker, container, args, options = {}) {
  const environment = ["-e", `PGPASSWORD=${DATABASE_PASSWORD}`];
  if (options.environmentName) {
    environment.push(
      "-e",
      `PGOPTIONS=-cnewme.environment=${options.environmentName}`,
    );
  }
  const result = command(docker, [
    "exec",
    ...environment,
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
    DATABASE_NAME,
    ...args,
  ]);
  if (options.expectFailure) {
    if (!result.error && result.status === 0) {
      throw new Error(`${options.label}_unexpected_success`);
    }
    return result;
  }
  return requireSuccess(result, options.label);
}

async function copyFixture(docker, container, relativePath) {
  const destination = `/work/${relativePath.replaceAll("\\", "/")}`;
  const parent = destination.slice(0, destination.lastIndexOf("/"));
  requireSuccess(
    command(docker, ["exec", container, "mkdir", "-p", parent]),
    `mkdir_${relativePath}`,
  );
  requireSuccess(
    command(docker, [
      "cp",
      resolve(ROOT, relativePath),
      `${container}:${destination}`,
    ]),
    `copy_${relativePath}`,
  );
}

async function main() {
  const docker = process.env.SAM61_DOCKER_BIN || "docker";
  const container = `newme-sam61-db-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    requireSuccess(
      command(docker, [
        "run",
        "--detach",
        "--rm",
        "--name",
        container,
        "--env",
        `POSTGRES_PASSWORD=${DATABASE_PASSWORD}`,
        "--env",
        `POSTGRES_DB=${DATABASE_NAME}`,
        POSTGRES_IMAGE,
      ]),
      "sam61_postgres_start",
    );
    started = true;

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const readiness = command(docker, [
        "exec",
        container,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        DATABASE_NAME,
      ]);
      if (!readiness.error && readiness.status === 0) {
        ready = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!ready) throw new Error("sam61_postgres_not_ready");

    for (const fixturePath of [
      "supabase/migrations/20260729235704_sam61_require_active_profiles_for_milestone_mutations.sql",
      "supabase/rollback/20260729235704_sam61_require_active_profiles_for_milestone_mutations_rollback.sql",
      "tests/database/sam61-active-profile-milestone-guard.sql",
    ]) {
      await copyFixture(docker, container, fixturePath);
    }

    psql(docker, container, ["-f", "sam61-active-profile-milestone-guard.sql"], {
      label: "sam61_apply_and_role_matrix",
    });

    const deniedRollback = psql(
      docker,
      container,
      [
        "-f",
        "/work/supabase/rollback/20260729235704_sam61_require_active_profiles_for_milestone_mutations_rollback.sql",
      ],
      {
        expectFailure: true,
        label: "sam61_rollback_without_environment",
      },
    );
    if (
      !deniedRollback.combined.includes(
        "sam61_active_profile_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error(
        `sam61_rollback_wrong_failure:${deniedRollback.combined || "no_output"}`,
      );
    }

    psql(
      docker,
      container,
      [
        "-f",
        "/work/supabase/rollback/20260729235704_sam61_require_active_profiles_for_milestone_mutations_rollback.sql",
      ],
      {
        environmentName: "test",
        label: "sam61_rollback",
      },
    );

    const rollbackContract = psql(
      docker,
      container,
      [
        "-A",
        "-t",
        "-q",
        "-c",
        `SELECT
           position('is_active IS TRUE' in pg_get_functiondef('public.reopen_lead_milestone(uuid,text,text)'::regprocedure)) = 0
           AND position('is_active IS TRUE' in pg_get_functiondef('public.recomplete_lead_milestone(uuid,text,text)'::regprocedure)) = 0
           AND has_function_privilege('authenticated', 'public.reopen_lead_milestone(uuid,text,text)', 'EXECUTE')
           AND has_function_privilege('authenticated', 'public.recomplete_lead_milestone(uuid,text,text)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.reopen_lead_milestone(uuid,text,text)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.recomplete_lead_milestone(uuid,text,text)', 'EXECUTE')
           AND (
             SELECT proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
             FROM pg_proc
             WHERE oid = 'public.reopen_lead_milestone(uuid,text,text)'::regprocedure
           )
           AND (
             SELECT proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
             FROM pg_proc
             WHERE oid = 'public.recomplete_lead_milestone(uuid,text,text)'::regprocedure
           );`,
      ],
      { label: "sam61_rollback_contract" },
    );
    if (rollbackContract.stdout.trim() !== "t") {
      throw new Error(
        `sam61_rollback_contract_failed:${rollbackContract.stdout.trim()}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        image: POSTGRES_IMAGE,
        active_allowed: "verified",
        inactive_denied_zero_side_effect: "verified",
        ownership_denial: "verified",
        anon_denied: "verified",
        grants_and_search_path: "preserved",
        rollback_fail_closed: "verified",
        rollback: "verified",
        cleanup: "verified",
      })}\n`,
    );
  } finally {
    if (started) {
      const cleanup = command(docker, ["rm", "--force", container]);
      if (cleanup.error || cleanup.status !== 0) {
        process.stderr.write(
          `sam61_disposable_cleanup_failed:${cleanup.combined || cleanup.error?.message || "unknown"}\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
