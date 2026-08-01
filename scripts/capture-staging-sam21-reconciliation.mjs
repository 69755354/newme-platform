#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const STAGING_PROJECT_REF = "bfsiibofuzoglziltgyd";
const STAGING_DATABASE_HOST = "aws-0-ap-southeast-1.pooler.supabase.com";
const STAGING_DATABASE_USER = `postgres.${STAGING_PROJECT_REF}`;
const RECONCILIATION_CONTRACT = "sam21-readonly-reconciliation-v1";
const MAX_OUTPUT_BYTES = 128 * 1024;

function required(name, pattern) {
  const value = process.env[name];
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`sam21_missing_or_invalid_env:${name}`);
  }
  return value;
}

function gitBlobSha(content) {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAggregateObject(value, label) {
  if (!plainObject(value) || Object.keys(value).length === 0) {
    throw new Error(`sam21_${label}_invalid`);
  }
  for (const count of Object.values(value)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`sam21_${label}_count_invalid`);
    }
  }
}

export function validateCapturedEvidence(evidence) {
  if (!plainObject(evidence)) throw new Error("sam21_evidence_invalid");
  if (evidence.contract !== RECONCILIATION_CONTRACT) {
    throw new Error("sam21_contract_invalid");
  }
  if (!["pre", "post"].includes(evidence.schema_phase)) {
    throw new Error("sam21_schema_phase_invalid");
  }
  if (evidence.transaction_read_only !== true) {
    throw new Error("sam21_transaction_not_read_only");
  }
  validateAggregateObject(evidence.aggregate_counts, "aggregate_counts");
  validateAggregateObject(evidence.stage_counts, "stage_counts");
  validateAggregateObject(evidence.orphan_counts, "orphan_counts");
  if (
    typeof evidence.quotation_value_total !== "number" ||
    !Number.isFinite(evidence.quotation_value_total)
  ) {
    throw new Error("sam21_quotation_total_invalid");
  }
  for (const digestName of [
    "lead_owner_digest",
    "history_relationship_digest",
    "document_ownership_digest",
  ]) {
    if (!/^[0-9a-f]{32}$/.test(evidence[digestName] ?? "")) {
      throw new Error(`sam21_${digestName}_invalid`);
    }
  }
  if (evidence.schema_phase === "post") {
    for (const countName of [
      "legacy_lead_count",
      "non_legacy_lead_count",
      "legacy_snapshot_count",
      "active_legacy_membership_count",
    ]) {
      if (!Number.isInteger(evidence[countName]) || evidence[countName] < 0) {
        throw new Error(`sam21_${countName}_invalid`);
      }
    }
    if (!plainObject(evidence.migration_history)) {
      throw new Error("sam21_migration_history_invalid");
    }
    for (const value of Object.values(evidence.migration_history)) {
      if (
        !plainObject(value) ||
        typeof value.name !== "string" ||
        value.name.length === 0 ||
        !Number.isInteger(value.statement_count) ||
        value.statement_count <= 0
      ) {
        throw new Error("sam21_migration_history_entry_invalid");
      }
    }
  }
  return evidence;
}

async function main() {
  const expectedSha = required(
    "SAM21_EXPECTED_RELEASE_SHA",
    /^[0-9a-f]{40}$/,
  );
  const expectedSqlBlob = required("SAM21_SQL_BLOB", /^[0-9a-f]{40}$/);
  const sqlPath = required("SAM21_SQL_PATH");
  const pgpassFile = required("PGPASSFILE");

  if (process.env.SAM21_PROJECT_REF !== STAGING_PROJECT_REF) {
    throw new Error("sam21_wrong_project_ref");
  }
  if (!sqlPath.startsWith("/run/newme-staging-sam21-")) {
    throw new Error("sam21_sql_path_not_root_scoped");
  }
  if (pgpassFile !== "/etc/newme-staging/sam21-db.pgpass") {
    throw new Error("sam21_pgpass_path_invalid");
  }
  const pgpassStat = await lstat(pgpassFile);
  if (
    !pgpassStat.isFile() ||
    pgpassStat.isSymbolicLink() ||
    pgpassStat.uid !== 0 ||
    pgpassStat.gid !== 0 ||
    (pgpassStat.mode & 0o777) !== 0o600
  ) {
    throw new Error("sam21_pgpass_owner_or_mode_invalid");
  }

  const sql = await readFile(sqlPath);
  if (gitBlobSha(sql) !== expectedSqlBlob) {
    throw new Error("sam21_reconciliation_sql_blob_mismatch");
  }
  const result = spawnSync(
    "/usr/bin/psql",
    [
      "-X",
      "--quiet",
      "--no-password",
      "--set",
      "ON_ERROR_STOP=1",
      "--host",
      STAGING_DATABASE_HOST,
      "--port",
      "5432",
      "--username",
      STAGING_DATABASE_USER,
      "--dbname",
      "postgres",
      "--file",
      sqlPath,
    ],
    {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: {
        HOME: "/root",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        PGAPPNAME: "newme-sam21-reconciliation",
        PGCONNECT_TIMEOUT: "10",
        PGPASSFILE: pgpassFile,
        PGSSLMODE: "verify-full",
        PGOPTIONS: "-c default_transaction_read_only=on",
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("sam21_readonly_reconciliation_query_failed");
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("sam21_reconciliation_output_too_large");
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("sam21_reconciliation_output_shape_invalid");
  }
  let evidence;
  try {
    evidence = validateCapturedEvidence(JSON.parse(lines[0]));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("sam21_reconciliation_output_json_invalid");
    }
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    linearId: "SAM-21",
    releaseSha: expectedSha,
    projectRef: STAGING_PROJECT_REF,
    sqlBlob: expectedSqlBlob,
    capturedAt: new Date().toISOString(),
    schemaPhase: evidence.schema_phase,
    evidence,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
