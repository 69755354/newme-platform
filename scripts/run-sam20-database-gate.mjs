#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const DATABASE_NAME = "sam20";
const DATABASE_PASSWORD = "sam20-disposable-only";
const TABLES = [
  "organizations",
  "memberships",
  "platform_staff",
  "support_sessions",
  "audit_events",
];

function command(docker, args, options = {}) {
  const result = spawnSync(docker, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  return {
    ...result,
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(`${label}_failed:${result.combined || result.error?.message || "unknown"}`);
  }
  return result;
}

function psql(docker, container, args, options = {}) {
  const environment = [
    "-e",
    `PGPASSWORD=${DATABASE_PASSWORD}`,
  ];
  if (options.environmentName) {
    environment.push("-e", `PGOPTIONS=-cnewme.environment=${options.environmentName}`);
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

function extractBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`database_type_marker_missing:${marker}`);
  const openIndex = source.indexOf("{", markerIndex + marker.length - 1);
  if (openIndex < 0) throw new Error(`database_type_block_missing:${marker}`);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error(`database_type_block_unclosed:${marker}`);
}

function postgresType(column) {
  const mapping = {
    bool: "boolean",
    int2: "number",
    int4: "number",
    int8: "number",
    numeric: "number",
    float4: "number",
    float8: "number",
    json: "Json",
    jsonb: "Json",
    text: "string",
    timestamptz: "string",
    timestamp: "string",
    uuid: "string",
  };
  const mapped = mapping[column.udt_name];
  if (!mapped) throw new Error(`unsupported_database_type:${column.table_name}.${column.column_name}:${column.udt_name}`);
  return mapped;
}

function parseProperties(block) {
  const properties = new Map();
  for (const match of block.matchAll(/^\s+([a-z][a-z0-9_]*)(\?)?: ([^\r\n]+)$/gm)) {
    properties.set(match[1], `${match[2] ?? ""}: ${match[3]}`);
  }
  return properties;
}

function expectedProperty(column, section) {
  const nullable = column.is_nullable === "YES";
  const type = `${postgresType(column)}${nullable ? " | null" : ""}`;
  if (section === "Row") return `: ${type}`;
  if (section === "Update") return `?: ${type}`;
  const optional = nullable || column.column_default !== null;
  return `${optional ? "?" : ""}: ${type}`;
}

export function verifyDatabaseTypes(source, contract) {
  const groupedColumns = new Map();
  for (const column of contract.columns) {
    const list = groupedColumns.get(column.table_name) ?? [];
    list.push(column);
    groupedColumns.set(column.table_name, list);
  }

  for (const table of [...TABLES, "leads"]) {
    const columns = groupedColumns.get(table) ?? [];
    if (columns.length === 0) throw new Error(`database_contract_table_missing:${table}`);
    const tableBlock = extractBlock(source, `      ${table}: {`);
    for (const section of ["Row", "Insert", "Update"]) {
      const sectionBlock = extractBlock(tableBlock, `${section}: {`);
      const properties = parseProperties(sectionBlock);
      const expectedColumns =
        table === "leads" ? columns.filter((column) => column.column_name === "organization_id") : columns;
      for (const column of expectedColumns) {
        const actual = properties.get(column.column_name);
        const expected = expectedProperty(column, section);
        if (actual !== expected) {
          throw new Error(
            `database_type_mismatch:${table}.${section}.${column.column_name}:expected=${expected}:actual=${actual ?? "missing"}`,
          );
        }
      }
      if (table !== "leads" && properties.size !== expectedColumns.length) {
        throw new Error(
          `database_type_column_count_mismatch:${table}.${section}:expected=${expectedColumns.length}:actual=${properties.size}`,
        );
      }
    }
  }

  for (const foreignKey of contract.foreign_keys) {
    const tableBlock = extractBlock(source, `      ${foreignKey.table_name}: {`);
    const requiredTokens = [
      `foreignKeyName: "${foreignKey.constraint_name}"`,
      `columns: ["${foreignKey.column_name}"]`,
      `referencedRelation: "${foreignKey.referenced_table_name}"`,
      `referencedColumns: ["${foreignKey.referenced_column_name}"]`,
    ];
    if (!requiredTokens.every((token) => tableBlock.includes(token))) {
      throw new Error(`database_type_relationship_missing:${foreignKey.constraint_name}`);
    }
  }

  if (contract.requested_organization_id_return !== "uuid") {
    throw new Error(
      `database_function_contract_mismatch:requested_organization_id:${contract.requested_organization_id_return}`,
    );
  }
  if (!source.includes("requested_organization_id: { Args: never; Returns: string }")) {
    throw new Error("database_type_function_missing:requested_organization_id");
  }
}

function queryJson(docker, container, sql, label) {
  const result = psql(docker, container, ["-A", "-t", "-q", "-c", sql], { label });
  const value = result.stdout.trim();
  if (!value) throw new Error(`${label}_empty`);
  return JSON.parse(value);
}

async function copyFixture(docker, container, relativePath) {
  const destination = `/work/${relativePath.replaceAll("\\", "/")}`;
  const parent = destination.slice(0, destination.lastIndexOf("/"));
  requireSuccess(
    command(docker, ["exec", container, "mkdir", "-p", parent]),
    `mkdir_${relativePath}`,
  );
  requireSuccess(
    command(docker, ["cp", resolve(ROOT, relativePath), `${container}:${destination}`]),
    `copy_${relativePath}`,
  );
}

async function main() {
  const docker = process.env.SAM20_DOCKER_BIN || "docker";
  const container = `newme-sam20-db-${process.pid}-${randomUUID().slice(0, 8)}`;
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
      "sam20_postgres_start",
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
    if (!ready) throw new Error("sam20_postgres_not_ready");

    const fixturePaths = [
      "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
      "supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql",
      "tests/database/sam20-lead-organization-isolation.sql",
      "tests/database/sam20-lead-organization-rollback-verify.sql",
    ];
    for (const fixturePath of fixturePaths) {
      await copyFixture(docker, container, fixturePath);
    }

    psql(docker, container, ["-f", "sam20-lead-organization-isolation.sql"], {
      label: "sam20_apply_harness",
    });

    const columns = queryJson(
      docker,
      container,
      `SELECT json_agg(contract ORDER BY table_name, ordinal_position)
       FROM (
         SELECT table_name, column_name, ordinal_position, is_nullable, udt_name, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (
             table_name IN ('${TABLES.join("','")}')
             OR (table_name = 'leads' AND column_name = 'organization_id')
           )
       ) contract`,
      "sam20_schema_columns",
    );
    const foreignKeys = queryJson(
      docker,
      container,
      `SELECT COALESCE(json_agg(contract ORDER BY table_name, constraint_name), '[]'::json)
       FROM (
         SELECT
           source.table_name,
           source.constraint_name,
           source.column_name,
           target.table_name AS referenced_table_name,
           target.column_name AS referenced_column_name
         FROM information_schema.table_constraints constraint_row
         JOIN information_schema.key_column_usage source
           ON source.constraint_schema = constraint_row.constraint_schema
          AND source.constraint_name = constraint_row.constraint_name
         JOIN information_schema.constraint_column_usage target
           ON target.constraint_schema = constraint_row.constraint_schema
          AND target.constraint_name = constraint_row.constraint_name
         WHERE constraint_row.constraint_type = 'FOREIGN KEY'
           AND constraint_row.table_schema = 'public'
           AND target.table_schema = 'public'
           AND constraint_row.table_name IN ('${[...TABLES, "leads"].join("','")}')
       ) contract`,
      "sam20_schema_foreign_keys",
    );
    const functionReturn = queryJson(
      docker,
      container,
      `SELECT to_json(pg_get_function_result('public.requested_organization_id()'::regprocedure))`,
      "sam20_schema_function",
    );
    const typesSource = await readFile(resolve(ROOT, "src/types/database.ts"), "utf8");
    verifyDatabaseTypes(typesSource, {
      columns,
      foreign_keys: foreignKeys,
      requested_organization_id_return: functionReturn,
    });

    const deniedRollback = psql(
      docker,
      container,
      ["-f", "/work/supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql"],
      { expectFailure: true, label: "sam20_rollback_without_environment" },
    );
    if (!deniedRollback.combined.includes("sam20_rollback_requires_staging_or_test")) {
      throw new Error(
        `sam20_rollback_wrong_failure:${deniedRollback.combined || "no_output"}`,
      );
    }
    const appliedTable = psql(
      docker,
      container,
      ["-A", "-t", "-q", "-c", "SELECT to_regclass('public.organizations')::text"],
      { label: "sam20_failed_rollback_atomicity" },
    );
    if (appliedTable.stdout.trim() !== "organizations") {
      throw new Error(`sam20_failed_rollback_changed_schema:${appliedTable.stdout.trim()}`);
    }

    psql(
      docker,
      container,
      ["-f", "/work/supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql"],
      { environmentName: "test", label: "sam20_rollback" },
    );
    psql(docker, container, ["-f", "sam20-lead-organization-rollback-verify.sql"], {
      label: "sam20_rollback_verify",
    });

    process.stdout.write(`${JSON.stringify({
      status: "passed",
      image: POSTGRES_IMAGE,
      apply: "verified",
      rls_and_triggers: "verified",
      type_equivalence: "verified",
      rollback_fail_closed: "verified",
      rollback: "verified",
      fixture_cleanup: "verified",
      old_lead_contract: "verified",
    })}\n`);
  } finally {
    if (started) {
      const cleanup = command(docker, ["rm", "--force", container]);
      if (cleanup.error || cleanup.status !== 0) {
        process.stderr.write(
          `sam20_disposable_cleanup_failed:${cleanup.combined || cleanup.error?.message || "unknown"}\n`,
        );
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
