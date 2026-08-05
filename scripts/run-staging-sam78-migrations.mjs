#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const STAGING_REF = "bfsiibofuzoglziltgyd";
export const PRODUCTION_REF = "vfopmpxlhwzpxqegayew";
export const DATABASE_HOST = "aws-0-ap-southeast-1.pooler.supabase.com";
export const DATABASE_PORT = "5432";
export const DATABASE_NAME = "postgres";
// The existing application schema and migration history are owned by the
// staging project's postgres role. Table grants on a differently named LOGIN
// role do not confer ALTER ownership, so bind the executor to this exact
// staging owner and keep its credential in the dedicated root-only pgpass.
export const DATABASE_USER = `postgres.${STAGING_REF}`;
export const PSQL = "/usr/bin/psql";
export const CA_FILE = "/etc/newme-staging/supabase-root-2021-ca.crt";
export const PLATFORM_STAFF_ROLE_MAPPING_FILE =
  "/etc/newme-staging/sam78-platform-staff-role-mapping.json";
export const LOCK_KEY = "newme-sam78-staging-migrations-v1";
export const CANONICAL_BASE_SHA = "48783d936f70f265f6f4eba736420b5f39c1414e";

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: "20260803100000",
    name: "v4_tenant_capability_boundary",
    migrationEnv: "SAM78_MIGRATION_031000_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_031000_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_031000_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_031000_BLOB",
  }),
  Object.freeze({
    version: "20260803143000",
    name: "v4_tenant_lifecycle_closure",
    migrationEnv: "SAM78_MIGRATION_143000_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_143000_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_143000_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_143000_BLOB",
  }),
  Object.freeze({
    version: "20260804153000",
    name: "sam78_govern_v4_authenticated_rpcs",
    migrationEnv: "SAM78_MIGRATION_041530_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_041530_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_041530_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_041530_BLOB",
  }),
  Object.freeze({
    version: "20260804165734",
    name: "sam26_synthetic_audit_cleanup_boundary",
    migrationEnv: "SAM78_MIGRATION_041657_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_041657_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_041657_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_041657_BLOB",
  }),
  Object.freeze({
    version: "20260804185311",
    name: "sam80_shared_operational_services",
    migrationEnv: "SAM78_MIGRATION_041853_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_041853_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_041853_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_041853_BLOB",
  }),
  Object.freeze({
    version: "20260804193000",
    name: "sam20_synthetic_support_cleanup_boundary",
    migrationEnv: "SAM78_MIGRATION_041930_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_041930_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_041930_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_041930_BLOB",
  }),
  Object.freeze({
    version: "20260805000000",
    name: "sam78_product_saas_synthetic_cleanup_boundary",
    migrationEnv: "SAM78_MIGRATION_050000_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_050000_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_050000_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_050000_BLOB",
  }),
  Object.freeze({
    version: "20260805010000",
    name: "sam78_v4_exit_digest_contract",
    migrationEnv: "SAM78_MIGRATION_050100_PATH",
    migrationBlobEnv: "SAM78_MIGRATION_050100_BLOB",
    rollbackEnv: "SAM78_ROLLBACK_050100_PATH",
    rollbackBlobEnv: "SAM78_ROLLBACK_050100_BLOB",
  }),
  Object.freeze({
    version: "20260805020000",
    name: "sam81_real_estate_listing_foundation",
    migrationEnv: "SAM81_MIGRATION_050200_PATH",
    migrationBlobEnv: "SAM81_MIGRATION_050200_BLOB",
    rollbackEnv: "SAM81_ROLLBACK_050200_PATH",
    rollbackBlobEnv: "SAM81_ROLLBACK_050200_BLOB",
  }),
  Object.freeze({
    version: "20260805120000",
    name: "sam82_retail_catalog_inventory_pricing",
    migrationEnv: "SAM82_MIGRATION_051200_PATH",
    migrationBlobEnv: "SAM82_MIGRATION_051200_BLOB",
    rollbackEnv: "SAM82_ROLLBACK_051200_PATH",
    rollbackBlobEnv: "SAM82_ROLLBACK_051200_BLOB",
  }),
  Object.freeze({
    version: "20260805130000",
    name: "sam83_retail_order_procurement_fulfillment_finance",
    migrationEnv: "SAM83_MIGRATION_051300_PATH",
    migrationBlobEnv: "SAM83_MIGRATION_051300_BLOB",
    rollbackEnv: "SAM83_ROLLBACK_051300_PATH",
    rollbackBlobEnv: "SAM83_ROLLBACK_051300_BLOB",
  }),
  Object.freeze({
    version: "20260805190000",
    name: "v4_commercial_control_plane",
    migrationEnv: "SAM79_MIGRATION_051900_PATH",
    migrationBlobEnv: "SAM79_MIGRATION_051900_BLOB",
    rollbackEnv: "SAM79_ROLLBACK_051900_PATH",
    rollbackBlobEnv: "SAM79_ROLLBACK_051900_BLOB",
  }),
  Object.freeze({
    version: "20260806000000",
    name: "sam84_controlled_agent_integration_gateway",
    migrationEnv: "SAM84_MIGRATION_060000_PATH",
    migrationBlobEnv: "SAM84_MIGRATION_060000_BLOB",
    rollbackEnv: "SAM84_ROLLBACK_060000_PATH",
    rollbackBlobEnv: "SAM84_ROLLBACK_060000_BLOB",
  }),
]);

// This is the only non-contiguous V4 state accepted for the existing staging
// project. These migrations were applied by the earlier, independently
// audited staging rollout. The controller may add the canonical missing set,
// but it must reject every other partial, reordered, or polluted state.
export const KNOWN_STAGING_APPLIED_VERSIONS = Object.freeze([
  "20260803100000",
  "20260803143000",
  "20260804153000",
  "20260804165734",
  "20260804193000",
  "20260805000000",
  "20260805010000",
]);

function fail(message) {
  throw new Error(`SAM78_FAIL_CLOSED: ${message}`);
}

function skipTrivia(sql, start) {
  let cursor = start;
  while (cursor < sql.length) {
    if (/\s/.test(sql[cursor])) {
      cursor += 1;
      continue;
    }
    if (sql.startsWith("--", cursor)) {
      const end = sql.indexOf("\n", cursor + 2);
      cursor = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", cursor)) {
      let depth = 1;
      cursor += 2;
      while (cursor < sql.length && depth > 0) {
        if (sql.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sql.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) fail("unterminated block comment");
      continue;
    }
    break;
  }
  return cursor;
}

function usesBackslashEscapes(sql, quoteIndex) {
  const previous = sql[quoteIndex - 1] ?? "";
  const beforePrevious = sql[quoteIndex - 2] ?? "";
  const identifier = /[A-Za-z0-9_$]/;
  return (previous === "E" || previous === "e")
    && !identifier.test(beforePrevious);
}

export function splitSqlStatements(sql) {
  if (typeof sql !== "string" || !sql.trim()) fail("SQL is empty");
  const statements = [];
  let start = skipTrivia(sql, 0);
  let cursor = start;
  let quote = null;
  let backslashEscapes = false;
  let blockDepth = 0;

  while (cursor < sql.length) {
    if (quote === "single") {
      if (backslashEscapes && sql[cursor] === "\\") cursor += 2;
      else if (sql[cursor] === "'" && sql[cursor + 1] === "'") cursor += 2;
      else if (sql[cursor] === "'") { quote = null; backslashEscapes = false; cursor += 1; }
      else cursor += 1;
      continue;
    }
    if (quote === "double") {
      if (backslashEscapes && sql[cursor] === "\\") cursor += 2;
      else if (sql[cursor] === '"' && sql[cursor + 1] === '"') cursor += 2;
      else if (sql[cursor] === '"') { quote = null; backslashEscapes = false; cursor += 1; }
      else cursor += 1;
      continue;
    }
    if (typeof quote === "string" && quote.startsWith("$")) {
      if (sql.startsWith(quote, cursor)) {
        cursor += quote.length;
        quote = null;
      } else cursor += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (sql.startsWith("/*", cursor)) { blockDepth += 1; cursor += 2; }
      else if (sql.startsWith("*/", cursor)) { blockDepth -= 1; cursor += 2; }
      else cursor += 1;
      continue;
    }
    if (sql.startsWith("--", cursor)) {
      const end = sql.indexOf("\n", cursor + 2);
      cursor = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", cursor)) { blockDepth = 1; cursor += 2; continue; }
    if (sql[cursor] === "'") {
      quote = "single";
      backslashEscapes = usesBackslashEscapes(sql, cursor);
      cursor += 1;
      continue;
    }
    if (sql[cursor] === '"') {
      quote = "double";
      backslashEscapes = false;
      cursor += 1;
      continue;
    }
    if (sql[cursor] === "$") {
      const tag = sql.slice(cursor).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) { quote = tag; cursor += tag.length; continue; }
    }
    if (sql[cursor] === ";") {
      const statement = sql.slice(start, cursor).trim();
      if (statement) statements.push(statement);
      start = skipTrivia(sql, cursor + 1);
      cursor = start;
      continue;
    }
    cursor += 1;
  }
  if (quote || blockDepth > 0) fail("unterminated SQL quote or comment");
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function normalizedBoundary(statement) {
  const start = skipTrivia(statement, 0);
  return statement.slice(start).trim().replace(/\s+/g, " ").toUpperCase();
}

export function stripOuterTransaction(sql, label) {
  const statements = splitSqlStatements(sql);
  if (!/^(BEGIN|BEGIN TRANSACTION)$/.test(normalizedBoundary(statements[0] ?? ""))) {
    fail(`${label} must start with one top-level BEGIN`);
  }
  if (normalizedBoundary(statements.at(-1) ?? "") !== "COMMIT") {
    fail(`${label} must end with one top-level COMMIT`);
  }
  const body = statements.slice(1, -1);
  if (body.length === 0) fail(`${label} transaction body is empty`);
  if (body.some((statement) => /^(BEGIN|BEGIN TRANSACTION|COMMIT|ROLLBACK)$/.test(normalizedBoundary(statement)))) {
    fail(`${label} contains an unexpected top-level transaction boundary`);
  }
  return body;
}

export function parseMigrationHistoryManifest(text) {
  if (typeof text !== "string") fail("migration history manifest must be text");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (
    lines[0] !== "# schema-version=1"
    || lines[1] !== "# linear-id=SAM-78"
    || lines[2] !== `# canonical-base=${CANONICAL_BASE_SHA}`
  ) fail("migration history manifest header mismatch");
  const entries = lines.slice(3).map((line) => {
    const match = /^(\d{14})\t([a-z0-9][a-z0-9_]*)$/.exec(line);
    if (!match) fail("migration history manifest row is malformed");
    return { version: match[1], name: match[2] };
  });
  if (entries.length <= MIGRATIONS.length) fail("canonical migration history manifest is incomplete");
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && entries[index - 1].version >= entries[index].version) {
      fail("migration history manifest must be strictly ordered and unique");
    }
  }
  const target = entries.slice(-MIGRATIONS.length);
  if (target.some((entry, index) =>
    entry.version !== MIGRATIONS[index].version || entry.name !== MIGRATIONS[index].name)) {
    fail("SAM-78 migrations must be the exact canonical history tip");
  }
  return entries;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function textArray(statements) {
  return `ARRAY[${statements.map(sqlLiteral).join(",")} ]::text[]`;
}

function executeStatements(statements) {
  return statements.map((statement) => `${statement};`).join("\n");
}

function metadataPredicate(item) {
  return [
    `version = ${sqlLiteral(item.version)}`,
    `name IS NOT DISTINCT FROM ${sqlLiteral(item.name)}`,
    `statements IS NOT DISTINCT FROM ${textArray(item.statements)}`,
  ].join(" AND ");
}

function historyValues(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail("expected migration history is empty");
  return rows
    .map((item) => `(${sqlLiteral(item.version)}, ${sqlLiteral(item.name)})`)
    .join(",");
}

export function parsePlatformStaffRoleMapping(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("platform staff role mapping is not valid JSON");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail("platform staff role mapping must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > 1000) fail("platform staff role mapping is too large");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const roles = new Set([
    "platform_owner", "platform_ops", "platform_support", "platform_auditor",
  ]);
  for (const [staffId, role] of entries) {
    if (!uuid.test(staffId) || !roles.has(role)) {
      fail("platform staff role mapping entry is invalid");
    }
  }
  return JSON.stringify(Object.fromEntries(entries.sort(([left], [right]) =>
    left.localeCompare(right))));
}

function historyPreflight(plan, activePlan, action, expectedHistory, alreadyAppliedPlan = []) {
  const canonicalVersions = plan.map((item) => sqlLiteral(item.version)).join(", ");
  const activeVersions = activePlan.map((item) => sqlLiteral(item.version)).join(", ");
  const prefixes = plan.map((item) => `version LIKE ${sqlLiteral(`${item.version}%`)}`).join(" OR ");
  const exactMetadata = activePlan.map((item) => `(${metadataPredicate(item)})`).join(" OR ");
  const expected = action === "apply" ? 0 : activePlan.length;
  // A clean apply omits all V4 rows from the predecessor history. The one
  // audited staging state already contains seven V4 rows, so omit precisely
  // the active (still-missing) rows instead of assuming the V4 entries form a
  // contiguous suffix in the history manifest. Every unrelated row remains
  // required by the exact-set comparison below.
  const activeVersionSet = new Set(activePlan.map(({ version }) => version));
  const expectedRows = action === "apply"
    ? expectedHistory.filter(({ version }) => !activeVersionSet.has(version))
    : expectedHistory;
  const expectedValues = historyValues(expectedRows);
  const alreadyAppliedAssertion = alreadyAppliedPlan.length === 0
    ? ""
    : "  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE "
      + alreadyAppliedPlan.map((item) => "(" + metadataPredicate(item) + ")").join(" OR ")
      + ") <> " + String(alreadyAppliedPlan.length) + " THEN\n"
      + "    RAISE EXCEPTION 'SAM78 known applied migration metadata mismatch';\n"
      + "  END IF;";
  return `
DO $sam78_preflight$
DECLARE
  polluted_count integer;
  exact_count integer;
  missing_count integer;
  extra_count integer;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'SAM78 history table is missing';
  END IF;
  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations'
      AND (
        (column_name = 'version' AND data_type = 'text')
        OR (column_name = 'name' AND data_type = 'text')
        OR (column_name = 'statements' AND data_type = 'ARRAY' AND udt_name = '_text')
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'SAM78 history columns are incompatible';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'supabase_migrations'
      AND relation.relname = 'schema_migrations'
      AND constraint_row.contype = 'p'
      AND pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY (version)'
  ) THEN
    RAISE EXCEPTION 'SAM78 history primary key is incompatible';
  END IF;
  SELECT count(*) INTO missing_count
  FROM (
    SELECT expected.version, expected.name
    FROM (VALUES ${expectedValues}) AS expected(version, name)
    EXCEPT
    SELECT version, name FROM supabase_migrations.schema_migrations
  ) missing;
  SELECT count(*) INTO extra_count
  FROM (
    SELECT version, name FROM supabase_migrations.schema_migrations
    EXCEPT
    SELECT expected.version, expected.name
    FROM (VALUES ${expectedValues}) AS expected(version, name)
  ) extra;
  IF missing_count <> 0 OR extra_count <> 0 THEN
    RAISE EXCEPTION 'SAM78 complete migration history does not match canonical predecessor state';
  END IF;
  SELECT count(*) INTO polluted_count
  FROM supabase_migrations.schema_migrations
  WHERE (${prefixes}) AND version NOT IN (${canonicalVersions});
  IF polluted_count <> 0 THEN
    RAISE EXCEPTION 'SAM78 polluted migration version detected';
  END IF;
  SELECT count(*) INTO exact_count
  FROM supabase_migrations.schema_migrations
  WHERE ${exactMetadata};
  IF exact_count <> ${expected} THEN
    RAISE EXCEPTION 'SAM78 migration history is not in the required ${action} state';
  END IF;
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN (${activeVersions})) <> ${expected} THEN
    RAISE EXCEPTION 'SAM78 migration history metadata mismatch';
  END IF;
${alreadyAppliedAssertion}
END
$sam78_preflight$;`;
}

function historyVerification(plan, action, expectedHistory) {
  const versions = plan.map((item) => sqlLiteral(item.version)).join(", ");
  const expectedRows = action === "apply"
    ? expectedHistory
    : expectedHistory.slice(0, -plan.length);
  const expectedValues = historyValues(expectedRows);
  const targetAssertion = action === "rollback"
    ? `IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN (${versions})) THEN
        RAISE EXCEPTION 'SAM78 rollback history cleanup failed';
      END IF;`
    : `IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE ${plan.map((item) => `(${metadataPredicate(item)})`).join(" OR ")}) <> ${plan.length} THEN
        RAISE EXCEPTION 'SAM78 applied migration metadata mismatch';
      END IF;`;
  return `DO $sam78_history_verify$
  DECLARE
    missing_count integer;
    extra_count integer;
  BEGIN
    ${targetAssertion}
    SELECT count(*) INTO missing_count
    FROM (
      SELECT expected.version, expected.name
      FROM (VALUES ${expectedValues}) AS expected(version, name)
      EXCEPT
      SELECT version, name FROM supabase_migrations.schema_migrations
    ) missing;
    SELECT count(*) INTO extra_count
    FROM (
      SELECT version, name FROM supabase_migrations.schema_migrations
      EXCEPT
      SELECT expected.version, expected.name
      FROM (VALUES ${expectedValues}) AS expected(version, name)
    ) extra;
    IF missing_count <> 0 OR extra_count <> 0 THEN
      RAISE EXCEPTION 'SAM78 complete migration history verification failed';
    END IF;
  END $sam78_history_verify$;`;
}

export function buildTransactionSql({
  action, plan, activePlan = plan, expectedHistory, verifySql,
  platformStaffRoleMapping,
}) {
  if (!['apply', 'rollback'].includes(action)) fail("action must be apply or rollback");
  if (!Array.isArray(plan) || plan.length !== MIGRATIONS.length) fail("migration plan must contain the exact SAM-78 versions");
  if (plan.some((item, index) => item.version !== MIGRATIONS[index].version || item.name !== MIGRATIONS[index].name)) {
    fail("migration plan version or name drift");
  }
  if (!Array.isArray(activePlan) || activePlan.length === 0) {
    fail("active migration plan cannot be empty");
  }
  const activeVersions = new Set(activePlan.map(({ version }) => version));
  if (activeVersions.size !== activePlan.length || activePlan.some((item, index) =>
    item.version !== plan.find(({ version }) => version === item.version)?.version
    || item.name !== plan.find(({ version }) => version === item.version)?.name
    || (index > 0 && activePlan[index - 1].version >= item.version))) {
    fail("active migration plan must be an ordered canonical subset");
  }
  const alreadyAppliedPlan = plan.filter(({ version }) => !activeVersions.has(version));
  if (action === "apply" && !(
    alreadyAppliedPlan.length === 0
    || (alreadyAppliedPlan.length === KNOWN_STAGING_APPLIED_VERSIONS.length
      && alreadyAppliedPlan.every((item, index) => item.version === KNOWN_STAGING_APPLIED_VERSIONS[index]))
  )) {
    fail("apply only accepts the clean baseline or the exact known staging migration set");
  }
  if (action === "rollback" && activePlan.length !== plan.length) {
    fail("rollback must cover the complete SAM-78 plan");
  }
  if (!Array.isArray(expectedHistory) || expectedHistory.length <= plan.length) {
    fail("canonical migration history manifest is incomplete");
  }
  const targetHistory = expectedHistory.slice(-plan.length);
  if (targetHistory.some((item, index) =>
    item.version !== plan[index].version || item.name !== plan[index].name)) {
    fail("SAM-78 migrations must be the exact canonical history tip");
  }
  if (typeof verifySql !== "string" || !verifySql.trim()) fail("verification SQL is empty");
  if (action === "apply" && typeof platformStaffRoleMapping !== "string") {
    fail("platform staff role mapping is required for apply");
  }
  const ordered = action === "apply" ? activePlan : [...activePlan].reverse();
  const operations = ordered.map((item) => {
    if (action === "apply") {
      return `${executeStatements(item.statements)}
INSERT INTO supabase_migrations.schema_migrations(version, name, statements)
VALUES (${sqlLiteral(item.version)}, ${sqlLiteral(item.name)}, ${textArray(item.statements)});`;
    }
    return `${executeStatements(item.rollbackStatements)}
DELETE FROM supabase_migrations.schema_migrations
WHERE ${metadataPredicate(item)};
DO $sam78_deleted$ BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = ${sqlLiteral(item.version)}) THEN
    RAISE EXCEPTION 'SAM78 rollback history delete failed';
  END IF;
END $sam78_deleted$;`;
  }).join("\n");
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = pg_catalog, public, pg_temp;
SET LOCAL standard_conforming_strings = on;
DO $sam78_advisory_lock$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(${sqlLiteral(LOCK_KEY)}, 0)) THEN
    RAISE EXCEPTION 'SAM78 migration advisory lock is already held';
  END IF;
END
$sam78_advisory_lock$;
SET LOCAL newme.environment = 'staging';
SET LOCAL newme.sam78_action = ${sqlLiteral(action)};
SET LOCAL newme.sam78_apply_mode = ${sqlLiteral(
  activePlan.length === plan.length ? "full" : "known_gap"
)};
SET LOCAL newme.sam78_active_start_version = ${sqlLiteral(activePlan[0].version)};
${action === "apply" ? `SET LOCAL newme.platform_staff_role_mapping = ${sqlLiteral(platformStaffRoleMapping)};` : ""}
LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
${historyPreflight(
  plan, activePlan, action, expectedHistory, alreadyAppliedPlan
)}
SET LOCAL newme.sam78_verify_phase = 'pre';
${verifySql.trim()}
${operations}
${historyVerification(activePlan, action, expectedHistory)}
SET LOCAL newme.sam78_verify_phase = 'post';
${verifySql.trim()}
COMMIT;
`;
}

async function gitBlobSha(path) {
  const content = await readFile(path);
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

async function validateRootOnlyFile(path, mode, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== mode) {
    fail(`${label} must be a root-owned regular file with mode ${mode.toString(8)}`);
  }
}

async function loadPlan(env) {
  const plan = [];
  for (const migration of MIGRATIONS) {
    const migrationPath = env[migration.migrationEnv];
    const rollbackPath = env[migration.rollbackEnv];
    const migrationBlob = env[migration.migrationBlobEnv];
    const rollbackBlob = env[migration.rollbackBlobEnv];
    if (!migrationPath || !rollbackPath || !/^[0-9a-f]{40}$/.test(migrationBlob ?? "") || !/^[0-9a-f]{40}$/.test(rollbackBlob ?? "")) {
      fail(`missing exact source provenance for ${migration.version}`);
    }
    await validateRootOnlyFile(migrationPath, 0o400, `${migration.version} migration`);
    await validateRootOnlyFile(rollbackPath, 0o400, `${migration.version} rollback`);
    if (await gitBlobSha(migrationPath) !== migrationBlob || await gitBlobSha(rollbackPath) !== rollbackBlob) {
      fail(`${migration.version} source blob mismatch`);
    }
    plan.push({
      ...migration,
      statements: stripOuterTransaction(await readFile(migrationPath, "utf8"), `${migration.version} migration`),
      rollbackStatements: stripOuterTransaction(await readFile(rollbackPath, "utf8"), `${migration.version} rollback`),
    });
  }
  return plan;
}

async function loadExpectedHistory(env) {
  const manifestPath = env.SAM78_HISTORY_MANIFEST_PATH;
  const manifestBlob = env.SAM78_HISTORY_MANIFEST_BLOB;
  if (!manifestPath || !/^[0-9a-f]{40}$/.test(manifestBlob ?? "")) {
    fail("missing exact migration history manifest provenance");
  }
  await validateRootOnlyFile(manifestPath, 0o400, "migration history manifest");
  if (await gitBlobSha(manifestPath) !== manifestBlob) {
    fail("migration history manifest blob mismatch");
  }
  return parseMigrationHistoryManifest(await readFile(manifestPath, "utf8"));
}

async function loadPlatformStaffRoleMapping(env) {
  if (env.SAM78_PLATFORM_STAFF_ROLE_MAPPING_PATH !== PLATFORM_STAFF_ROLE_MAPPING_FILE) {
    fail("platform staff role mapping path mismatch");
  }
  if (!/^[0-9a-f]{64}$/.test(env.SAM78_PLATFORM_STAFF_ROLE_MAPPING_SHA256 ?? "")) {
    fail("platform staff role mapping checksum is invalid");
  }
  await validateRootOnlyFile(
    PLATFORM_STAFF_ROLE_MAPPING_FILE,
    0o600,
    "platform staff role mapping",
  );
  const content = await readFile(PLATFORM_STAFF_ROLE_MAPPING_FILE);
  const checksum = createHash("sha256").update(content).digest("hex");
  if (checksum !== env.SAM78_PLATFORM_STAFF_ROLE_MAPPING_SHA256) {
    fail("platform staff role mapping checksum mismatch");
  }
  return parsePlatformStaffRoleMapping(content.toString("utf8"));
}

export function psqlInvocation(env) {
  return {
    command: PSQL,
    args: [
      "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1",
      "--host", DATABASE_HOST, "--port", DATABASE_PORT,
      "--username", DATABASE_USER, "--dbname", DATABASE_NAME, "--file", "-",
    ],
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      PGPASSFILE: env.SAM78_PGPASS_PATH,
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: CA_FILE,
      PGCONNECT_TIMEOUT: "10",
      PGAPPNAME: "newme-sam78-staging-migration-executor",
    },
  };
}

export function parseAppliedMigrationSet(text) {
  if (typeof text !== "string" || text.length > 16_384) {
    fail("applied migration history output is invalid");
  }
  const rows = text.trim() === "" ? [] : text.trim().split(/\r?\n/);
  if (rows.length > MIGRATIONS.length) {
    fail("applied migration history contains duplicate target rows");
  }
  const applied = [];
  rows.forEach((row, index) => {
    const match = /^(\d{14})\t([a-z0-9][a-z0-9_]*)$/.exec(row);
    const item = match && MIGRATIONS.find(({ version }) => version === match[1]);
    if (!item || item.name !== match[2] || (index > 0 && rows[index - 1] >= row)) {
      fail("applied migration history is not an ordered canonical set");
    }
    if (applied.some(({ version }) => version === item.version)) {
      fail("applied migration history contains duplicate target rows");
    }
    applied.push(item);
  });
  return applied;
}

export function resolveStagingApplyPlan(appliedPlan) {
  if (!Array.isArray(appliedPlan)) fail("applied migration plan is invalid");
  const canonicalApplied = MIGRATIONS.filter(({ version }) =>
    appliedPlan.some((item) => item?.version === version));
  if (canonicalApplied.length !== appliedPlan.length
    || canonicalApplied.some((item, index) => item.version !== appliedPlan[index].version
      || item.name !== appliedPlan[index].name)) {
    fail("applied migration history is not an ordered canonical set");
  }
  if (canonicalApplied.length === MIGRATIONS.length) {
    fail("all SAM-78 migrations are already applied");
  }
  const isClean = canonicalApplied.length === 0;
  const isKnownStagingSet = canonicalApplied.length === KNOWN_STAGING_APPLIED_VERSIONS.length
    && canonicalApplied.every((item, index) => item.version === KNOWN_STAGING_APPLIED_VERSIONS[index]);
  if (!isClean && !isKnownStagingSet) {
    fail("apply only accepts the clean baseline or the exact known staging migration set");
  }
  return {
    appliedPlan: canonicalApplied,
    activePlan: MIGRATIONS.filter(({ version }) =>
      !canonicalApplied.some((item) => item.version === version)),
  };
}

export function psqlHistoryInvocation(env) {
  const invocation = psqlInvocation(env);
  const versions = MIGRATIONS.map(({ version }) => sqlLiteral(version)).join(", ");
  return {
    ...invocation,
    args: [
      "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1",
      "--tuples-only", "--no-align", "--field-separator", "\t",
      "--host", DATABASE_HOST, "--port", DATABASE_PORT,
      "--username", DATABASE_USER, "--dbname", DATABASE_NAME,
      "--command",
      `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version IN (${versions}) ORDER BY version`,
    ],
  };
}

async function detectAppliedMigrationSet(env) {
  const invocation = psqlHistoryInvocation(env);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 16_384) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(
        `SAM78_FAIL_CLOSED: migration history query failed code=${code ?? "null"} signal=${signal ?? "none"}; output redacted`,
      ));
    });
  });
  return parseAppliedMigrationSet(output);
}

async function runPsql(sql, env) {
  const invocation = psqlInvocation(env);
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20 * 60 * 1000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`psql failed code=${code ?? "null"} signal=${signal ?? "none"}; output redacted`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(sql);
  });
}

export async function main(env = process.env) {
  const action = env.SAM78_ACTION;
  if (!['apply', 'rollback'].includes(action)) fail("invalid action");
  if (env.SAM78_PROJECT_REF !== STAGING_REF || env.SAM78_PROJECT_REF === PRODUCTION_REF) fail("staging project ref mismatch");
  if (!/^[0-9a-f]{40}$/.test(env.SAM78_EXPECTED_RELEASE_SHA ?? "")) fail("invalid release SHA");
  if (!/^[0-9a-f]{64}$/.test(env.SAM78_BUILD_ARTIFACT_SHA256 ?? "")) fail("invalid build artifact checksum");
  if (env.SAM78_PGPASS_PATH !== "/etc/newme-staging/staging-migration.pgpass") fail("pgpass path mismatch");
  await validateRootOnlyFile(env.SAM78_PGPASS_PATH, 0o600, "pgpass");
  await validateRootOnlyFile(CA_FILE, 0o600, "Supabase CA");
  await validateRootOnlyFile(env.SAM78_VERIFY_SQL_PATH, 0o400, "verification SQL");
  if (!/^[0-9a-f]{40}$/.test(env.SAM78_VERIFY_SQL_BLOB ?? "") || await gitBlobSha(env.SAM78_VERIFY_SQL_PATH) !== env.SAM78_VERIFY_SQL_BLOB) {
    fail("verification SQL blob mismatch");
  }
  const plan = await loadPlan(env);
  const expectedHistory = await loadExpectedHistory(env);
  const detectedAppliedPlan = await detectAppliedMigrationSet(env);
  if (action === "rollback" && detectedAppliedPlan.length !== plan.length) {
    fail("rollback requires the complete SAM-78 migration plan to be applied");
  }
  const { appliedPlan, activePlan } = action === "apply"
    ? resolveStagingApplyPlan(detectedAppliedPlan)
    : { appliedPlan: detectedAppliedPlan, activePlan: plan };
  const platformStaffRoleMapping = action === "apply"
    ? await loadPlatformStaffRoleMapping(env)
    : undefined;
  const sql = buildTransactionSql({
    action,
    plan,
    activePlan,
    expectedHistory,
    platformStaffRoleMapping,
    verifySql: await readFile(env.SAM78_VERIFY_SQL_PATH, "utf8"),
  });
  await runPsql(sql, env);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    linearId: "SAM-78",
    releaseSha: env.SAM78_EXPECTED_RELEASE_SHA,
    projectRef: STAGING_REF,
    action,
    status: "passed",
    versions: MIGRATIONS.map(({ version }) => version),
    appliedVersions: activePlan.map(({ version }) => version),
    alreadyAppliedVersions: appliedPlan.map(({ version }) => version),
    history: "verified",
    historyManifestBlob: env.SAM78_HISTORY_MANIFEST_BLOB,
    buildArtifactSha256: env.SAM78_BUILD_ARTIFACT_SHA256,
    platformStaffRoleMappingSha256: action === "apply"
      ? env.SAM78_PLATFORM_STAFF_ROLE_MAPPING_SHA256
      : null,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message ?? "SAM78_FAIL_CLOSED: execution failed").slice(0, 512)}\n`);
    process.exitCode = 1;
  });
}
