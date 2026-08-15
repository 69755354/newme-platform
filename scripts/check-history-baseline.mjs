#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { splitSqlStatements } from "./split-sql-statements.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");
const EXPECTED_PROJECT_ID = "vfopmpxlhwzpxqegayew";
const EXPECTED_FORMAT = "newme-public-schema-baseline-v1";
const BODY_MARKER = "SET check_function_bodies = false;";
const ALLOWED_KINDS = new Set(["ALTER", "COMMENT", "CREATE", "GRANT", "RESET", "REVOKE", "SET"]);

function refuse(message) {
  throw new Error(message);
}

function requireFact(condition, message) {
  if (!condition) refuse(message);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Lf(text) {
  return createHash("sha256").update(String(text).replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    refuse(`${label} is missing or is not valid JSON`);
  }
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function leadingKeyword(statement) {
  const match = statement.match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : "";
}

function scanSecretShapes(text) {
  const patterns = [
    ["private-key", /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i],
    ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
    ["supabase-secret", /\bsb_secret_[A-Za-z0-9_-]+\b/i],
    ["credential-uri", /\bpostgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@/i],
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
    ["email-value", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["ipv4-value", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
    ["credential-assignment", /\b(?:secret|password|passwd|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function validateCaptureQuery(query) {
  requireFact(!query.startsWith("\uFEFF"), "capture query has a UTF-8 BOM");
  const statements = splitSqlStatements(query);
  requireFact(statements.length === 1, "capture query must contain exactly one top-level statement");
  const withoutLeadingComments = statements[0].replace(/^(?:\s*--[^\n]*(?:\n|$))+/, "").trimStart();
  requireFact(/^with\s+recursive\b/i.test(withoutLeadingComments), "capture query is not one read-only WITH RECURSIVE statement");
  requireFact(!/\b(?:insert|update|delete|merge|copy|truncate)\b/i.test(withoutLeadingComments.slice(withoutLeadingComments.lastIndexOf("select jsonb_build_object("))),
    "capture query final statement is not read-only");
  requireFact(query.includes("pg_catalog."), "capture query does not bind its catalog reads to pg_catalog");
}

function validateBaselineSql(sql, meta) {
  requireFact(!sql.startsWith("\uFEFF"), "baseline SQL has a UTF-8 BOM");
  requireFact(Number(meta.artifact?.bytes) === Buffer.byteLength(sql, "utf8"), "baseline byte count differs from metadata");
  requireFact(meta.artifact?.sha256 === sha256Bytes(Buffer.from(sql, "utf8")), "baseline SHA-256 differs from metadata");

  const marker = sql.indexOf(BODY_MARKER);
  requireFact(marker >= 0, "baseline SQL body marker is missing");
  const body = sql.slice(marker);
  requireFact(Number(meta.source?.body_bytes) === Buffer.byteLength(body, "utf8"), "baseline body byte count differs from metadata");
  requireFact(meta.source?.body_sha256 === sha256Bytes(Buffer.from(body, "utf8")), "baseline body SHA-256 differs from metadata");

  const secretShapes = scanSecretShapes(sql);
  requireFact(secretShapes.length === 0, `baseline contains forbidden secret-shaped material: ${secretShapes.join(", ")}`);

  const statements = splitSqlStatements(body);
  const counts = {};
  for (const [index, statement] of statements.entries()) {
    const kind = leadingKeyword(statement);
    requireFact(ALLOWED_KINDS.has(kind), `baseline statement ${index + 1} has forbidden top-level kind ${kind || "<none>"}`);
    requireFact(!/^CREATE\s+(?:UNLOGGED\s+)?TABLE\b[\s\S]*\bAS\s+SELECT\b/i.test(statement),
      `baseline statement ${index + 1} creates a table from row data`);
    requireFact(!/^CREATE\s+MATERIALIZED\s+VIEW\b/i.test(statement),
      `baseline statement ${index + 1} can materialize row data`);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  requireFact(Number(meta.integrity?.top_level_statement_count) === statements.length,
    "baseline top-level statement count differs from metadata");
  const declaredCounts = meta.integrity?.allowed_top_level_statement_counts ?? {};
  requireFact(JSON.stringify(Object.fromEntries(Object.entries(counts).sort())) ===
      JSON.stringify(Object.fromEntries(Object.entries(declaredCounts).sort())),
    "baseline top-level statement-kind counts differ from metadata");
  requireFact(meta.integrity?.application_table_rows_captured === false,
    "metadata does not explicitly refuse application table rows");
  requireFact(meta.integrity?.sequence_current_values_captured === false,
    "metadata does not explicitly refuse sequence current values");
  requireFact(Array.isArray(meta.integrity?.preflight_issues) && meta.integrity.preflight_issues.length === 0,
    "metadata records unresolved capture preflight issues");
  requireFact(meta.integrity?.sensitive_definition_count === 0,
    "metadata records sensitive schema definitions");

  const inventory = meta.inventory ?? {};
  for (const key of ["tables", "columns", "views", "functions", "constraints",
    "non_constraint_indexes", "triggers", "policies", "comments"]) {
    requireFact(Number.isInteger(inventory[key]) && inventory[key] >= 0,
      `baseline inventory field ${key} is missing or invalid`);
  }
  requireFact(counts.ALTER === inventory.constraints + (2 * inventory.tables),
    "baseline ALTER count does not match constraints plus RLS posture");
  requireFact(counts.COMMENT === inventory.comments,
    "baseline COMMENT count does not match inventory");
  requireFact(counts.CREATE === inventory.tables + inventory.functions +
      inventory.non_constraint_indexes + inventory.views + inventory.triggers + inventory.policies,
    "baseline CREATE count does not match captured object inventory");

  return { body, statementCount: statements.length, statementCounts: counts };
}

function validateForwardSet(root, meta) {
  const manifestPath = path.join(root, "infra", "release", "release-manifest.json");
  const manifest = readJson(manifestPath, "release manifest");
  const phases = [
    ["required_for_app", manifest.required_for_app],
    ["deferred_contract", manifest.deferred_contract],
  ];
  const forward = [];
  const seenVersions = new Set();
  const seenFiles = new Set();

  for (const [phase, entries] of phases) {
    requireFact(Array.isArray(entries) && entries.length > 0, `release manifest phase ${phase} is empty`);
    for (const entry of entries) {
      const version = String(entry?.version ?? "");
      const file = String(entry?.file ?? "");
      const expectedHash = String(entry?.sha256 ?? "");
      requireFact(/^\d{14}$/.test(version), `${phase} contains an invalid migration version`);
      requireFact(version > meta.capture.production_history_watermark,
        `${phase} contains a migration at or before the baseline watermark`);
      requireFact(file === path.basename(file) && file.startsWith(`${version}_`) && /^\d{14}_.+\.sql$/.test(file),
        `${phase} contains an invalid migration filename`);
      requireFact(/^[0-9a-f]{64}$/.test(expectedHash), `${phase} migration ${file} has no valid SHA-256`);
      requireFact(!seenVersions.has(version), `release manifest repeats migration version ${version}`);
      requireFact(!seenFiles.has(file), `release manifest repeats migration file ${file}`);
      seenVersions.add(version);
      seenFiles.add(file);

      const migrationPath = path.join(root, "supabase", "migrations", file);
      requireFact(fs.existsSync(migrationPath), `release manifest migration is missing: ${file}`);
      const actualHash = sha256Lf(fs.readFileSync(migrationPath, "utf8"));
      requireFact(actualHash === expectedHash, `release manifest migration hash differs: ${file}`);
      forward.push(file);
    }
  }

  const sorted = [...forward].sort();
  requireFact(sameList(forward, sorted), "release manifest forward migrations are not in exact application order");

  const watermark = meta.capture.production_history_watermark;
  const onDisk = fs.readdirSync(path.join(root, "supabase", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{14}_.+\.sql$/.test(entry.name) && entry.name.slice(0, 14) > watermark)
    .map((entry) => entry.name)
    .sort();
  requireFact(sameList(forward, onDisk),
    "release manifest is not the exact set of timestamped migrations after the baseline watermark");

  return { forward, manifest };
}

export function verifyHistoryBaseline({ root = DEFAULT_ROOT } = {}) {
  const sqlPath = path.join(root, "supabase", "replay", "production-schema-baseline.sql");
  const metaPath = path.join(root, "supabase", "replay", "production-schema-baseline.json");
  const captureQueryPath = path.join(root, "supabase", "replay", "capture-production-schema-baseline.sql");
  const reconciliationPath = path.join(root, "supabase", "migration-history-reconciliation.json");

  requireFact(fs.existsSync(sqlPath), "production schema baseline SQL is missing");
  requireFact(fs.existsSync(metaPath), "production schema baseline metadata is missing");
  requireFact(fs.existsSync(captureQueryPath), "production schema baseline capture query is missing");
  requireFact(fs.existsSync(reconciliationPath), "migration history reconciliation is missing");

  const sql = fs.readFileSync(sqlPath, "utf8");
  const meta = readJson(metaPath, "production schema baseline metadata");
  const captureQuery = fs.readFileSync(captureQueryPath, "utf8");
  const reconciliationBytes = fs.readFileSync(reconciliationPath);
  const reconciliation = readJson(reconciliationPath, "migration history reconciliation");

  requireFact(meta.format === EXPECTED_FORMAT, "baseline metadata format is not recognized");
  requireFact(meta.capture?.project_id === EXPECTED_PROJECT_ID, "baseline metadata names the wrong production project");
  requireFact(/^17\d{4}$/.test(String(meta.capture?.server_version_num ?? "")),
    "baseline metadata does not bind a PostgreSQL 17 server");
  requireFact(!Number.isNaN(Date.parse(String(meta.capture?.captured_at ?? ""))),
    "baseline capture time is missing or invalid");
  requireFact(/^\d{14}$/.test(String(meta.capture?.production_history_watermark ?? "")),
    "baseline production history watermark is invalid");
  requireFact(Number(meta.capture?.production_history_row_count) > 0,
    "baseline production history row count is not positive");

  validateCaptureQuery(captureQuery);
  requireFact(meta.source?.capture_query_sha256 === sha256Bytes(Buffer.from(captureQuery, "utf8")),
    "capture query SHA-256 differs from metadata");

  requireFact(meta.capture?.history_reconciliation_sha256 === sha256Bytes(reconciliationBytes),
    "history reconciliation SHA-256 differs from baseline metadata");
  requireFact(meta.capture?.production_history_row_count === reconciliation.capture?.row_count,
    "baseline and history reconciliation row counts differ");
  requireFact(meta.capture?.production_history_rows_sha256 === reconciliation.capture?.rows_sha256,
    "baseline and history reconciliation row digests differ");
  requireFact(Array.isArray(reconciliation.rows) && reconciliation.rows.length === reconciliation.capture?.row_count,
    "history reconciliation row array does not match its declared count");
  const reconciledVersions = reconciliation.rows.map((row) => String(row?.version ?? "")).sort();
  requireFact(reconciledVersions.at(-1) === meta.capture.production_history_watermark,
    "baseline watermark is not the maximum reconciled production migration version");

  const baseline = validateBaselineSql(sql, meta);
  const release = validateForwardSet(root, meta);

  return {
    projectId: meta.capture.project_id,
    capturedAt: meta.capture.captured_at,
    watermark: meta.capture.production_history_watermark,
    productionHistoryRows: meta.capture.production_history_row_count,
    baselineSha256: meta.artifact.sha256,
    baselineBytes: meta.artifact.bytes,
    baselineStatementCount: baseline.statementCount,
    inventory: meta.inventory,
    forward: release.forward,
  };
}

function main() {
  try {
    const summary = verifyHistoryBaseline();
    if (process.argv.includes("--print-forward")) {
      process.stdout.write(summary.forward.join("\n") + "\n");
      return;
    }
    if (process.argv.includes("--print-inventory")) {
      const inventory = summary.inventory;
      process.stdout.write([
        inventory.tables,
        inventory.columns,
        inventory.views,
        inventory.functions,
        inventory.constraints,
        inventory.non_constraint_indexes,
        inventory.triggers,
        inventory.policies,
      ].join("|") + "\n");
      return;
    }
    process.stdout.write(JSON.stringify(summary) + "\n");
  } catch (error) {
    console.error(`history baseline refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
