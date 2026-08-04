#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const DATABASE = "sam81";
const PASSWORD = "sam81-disposable-only";

function run(docker, args) {
  const result = spawnSync(docker, args, { cwd: ROOT, encoding: "utf8", env: process.env });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(`sam81_${args[0]}_failed:${output || result.error?.message || "unknown"}`);
  }
  return result;
}

async function main() {
  const docker = process.env.SAM81_DOCKER_BIN || "docker";
  const container = `newme-sam81-db-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    run(docker, ["run", "--detach", "--rm", "--name", container,
      "--env", `POSTGRES_PASSWORD=${PASSWORD}`, "--env", `POSTGRES_DB=${DATABASE}`, IMAGE]);
    started = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = spawnSync(docker, ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", DATABASE], {
        cwd: ROOT, encoding: "utf8", env: process.env,
      });
      if (!result.error && result.status === 0) break;
      if (attempt === 59) throw new Error("sam81_postgres_not_ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    for (const path of [
      "supabase/migrations/20260805020000_sam81_real_estate_listing_foundation.sql",
      "supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql",
      "tests/database/sam81-real-estate-listing-foundation.sql",
    ]) {
      const destination = `/work/${path.replaceAll("\\", "/")}`;
      const parent = destination.slice(0, destination.lastIndexOf("/"));
      run(docker, ["exec", container, "mkdir", "-p", parent]);
      run(docker, ["cp", resolve(ROOT, path), `${container}:${destination}`]);
    }
    run(docker, ["exec", "-e", `PGPASSWORD=${PASSWORD}`, "-w", "/work/tests/database", container,
      "psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "postgres", "-d", DATABASE,
      "-f", "sam81-real-estate-listing-foundation.sql"]);
    process.stdout.write(`${JSON.stringify({
      status: "passed", image: IMAGE, organization_isolation: "verified",
      inactive_denial: "verified", listing_readiness: "verified",
      viewing_idempotency: "verified", adapter_disabled: "verified", rollback: "verified",
    })}\n`);
  } finally {
    if (started) {
      const cleanup = spawnSync(docker, ["rm", "--force", container], {
        cwd: ROOT, encoding: "utf8", env: process.env,
      });
      if (cleanup.error || cleanup.status !== 0) {
        process.stderr.write(`sam81_disposable_cleanup_failed:${cleanup.stderr || cleanup.error?.message || "unknown"}\n`);
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
