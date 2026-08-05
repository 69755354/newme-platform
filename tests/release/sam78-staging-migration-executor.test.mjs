import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  CA_FILE,
  CANONICAL_BASE_SHA,
  DATABASE_USER,
  KNOWN_STAGING_APPLIED_VERSIONS,
  KNOWN_STAGING_APPLIED_HISTORY_SHA256,
  MIGRATIONS,
  PLATFORM_STAFF_ROLE_MAPPING_FILE,
  STAGING_REF,
  buildTransactionSql,
  bindMigrationPlanEntries,
  parseAppliedMigrationSet,
  resolveStagingApplyPlan,
  parseMigrationHistoryManifest,
  parsePlatformStaffRoleMapping,
  psqlInvocation,
  psqlHistoryInvocation,
  splitSqlStatements,
  stripOuterTransaction,
} from "../../scripts/run-staging-sam78-migrations.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const paths = [
  {
    version: "20260803100000",
    name: "v4_tenant_capability_boundary",
    migration: "supabase/migrations/20260803100000_v4_tenant_capability_boundary.sql",
    rollback: "supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql",
  },
  {
    version: "20260803143000",
    name: "v4_tenant_lifecycle_closure",
    migration: "supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql",
    rollback: "supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql",
  },
  {
    version: "20260804153000",
    name: "sam78_govern_v4_authenticated_rpcs",
    migration: "supabase/migrations/20260804153000_sam78_govern_v4_authenticated_rpcs.sql",
    rollback: "supabase/rollback/20260804153000_sam78_govern_v4_authenticated_rpcs_rollback.sql",
  },
  {
    version: "20260804165734",
    name: "sam26_synthetic_audit_cleanup_boundary",
    migration: "supabase/migrations/20260804165734_sam26_synthetic_audit_cleanup_boundary.sql",
    rollback: "supabase/rollback/20260804165734_sam26_synthetic_audit_cleanup_boundary_rollback.sql",
  },
  {
    version: "20260804185311",
    name: "sam80_shared_operational_services",
    migration: "supabase/migrations/20260804185311_sam80_shared_operational_services.sql",
    rollback: "supabase/rollback/20260804185311_sam80_shared_operational_services_rollback.sql",
  },
  {
    version: "20260804193000",
    name: "sam20_synthetic_support_cleanup_boundary",
    migration: "supabase/migrations/20260804193000_sam20_synthetic_support_cleanup_boundary.sql",
    rollback: "supabase/rollback/20260804193000_sam20_synthetic_support_cleanup_boundary_rollback.sql",
  },
  {
    version: "20260805000000",
    name: "sam78_product_saas_synthetic_cleanup_boundary",
    migration: "supabase/migrations/20260805000000_sam78_product_saas_synthetic_cleanup_boundary.sql",
    rollback: "supabase/rollback/20260805000000_sam78_product_saas_synthetic_cleanup_boundary_rollback.sql",
  },
  {
    version: "20260805010000",
    name: "sam78_v4_exit_digest_contract",
    migration: "supabase/migrations/20260805010000_sam78_v4_exit_digest_contract.sql",
    rollback: "supabase/rollback/20260805010000_sam78_v4_exit_digest_contract_rollback.sql",
  },
  {
    version: "20260805020000",
    name: "sam81_real_estate_listing_foundation",
    migration: "supabase/migrations/20260805020000_sam81_real_estate_listing_foundation.sql",
    rollback: "supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql",
  },
  {
    version: "20260805120000",
    name: "sam82_retail_catalog_inventory_pricing",
    migration: "supabase/migrations/20260805120000_sam82_retail_catalog_inventory_pricing.sql",
    rollback: "supabase/rollback/20260805120000_sam82_retail_catalog_inventory_pricing_rollback.sql",
  },
  {
    version: "20260805130000",
    name: "sam83_retail_order_procurement_fulfillment_finance",
    migration: "supabase/migrations/20260805130000_sam83_retail_order_procurement_fulfillment_finance.sql",
    rollback: "supabase/rollback/20260805130000_sam83_retail_order_procurement_fulfillment_finance_rollback.sql",
  },
  {
    version: "20260805190000",
    name: "v4_commercial_control_plane",
    migration: "supabase/migrations/20260805190000_v4_commercial_control_plane.sql",
    rollback: "supabase/rollback/20260805190000_v4_commercial_control_plane_rollback.sql",
  },
  {
    version: "20260806000000",
    name: "sam84_controlled_agent_integration_gateway",
    migration: "supabase/migrations/20260806000000_sam84_controlled_agent_integration_gateway.sql",
    rollback: "supabase/rollback/20260806000000_sam84_controlled_agent_integration_gateway_rollback.sql",
  },
  {
    version: "20260806010000",
    name: "v4_fix_membership_paid_seat_trigger",
    migration: "supabase/migrations/20260806010000_v4_fix_membership_paid_seat_trigger.sql",
    rollback: "supabase/rollback/20260806010000_v4_fix_membership_paid_seat_trigger_rollback.sql",
  },
  {
    version: "20260806020000",
    name: "sam83_v4_synthetic_cleanup_boundary",
    migration: "supabase/migrations/20260806020000_sam83_v4_synthetic_cleanup_boundary.sql",
    rollback: "supabase/rollback/20260806020000_sam83_v4_synthetic_cleanup_boundary_rollback.sql",
  },
];

async function expectedHistory() {
  return parseMigrationHistoryManifest(
    await read("scripts/uat/sam78-canonical-migration-history.txt"),
  );
}

async function plan() {
  return Promise.all(paths.map(async (item) => ({
    ...item,
    statements: stripOuterTransaction(await read(item.migration), `${item.version} migration`),
    rollbackStatements: stripOuterTransaction(await read(item.rollback), `${item.version} rollback`),
  })));
}

test("SAM-78 plan uses the fixed staging owner and exact canonical history tip", async () => {
  assert.deepEqual(
    MIGRATIONS.map(({ version, name }) => ({ version, name })),
    paths.map(({ version, name }) => ({ version, name })),
  );
  assert.equal(DATABASE_USER, `postgres.${STAGING_REF}`);
  assert.equal(CANONICAL_BASE_SHA, "48783d936f70f265f6f4eba736420b5f39c1414e");

  const manifest = await expectedHistory();
  const migrationFiles = (await readdir(new URL("supabase/migrations/", root)))
    .filter((name) => /^\d{14}_[a-z0-9][a-z0-9_]*\.sql$/.test(name))
    .sort();
  assert.deepEqual(manifest.map(({ version, name }) => `${version}_${name}.sql`), migrationFiles);
  assert.deepEqual(manifest.slice(-paths.length), paths.map(({ version, name }) => ({ version, name })));
});

test("migration history manifest accepts CRLF but rejects header, order, row, and tip drift", async () => {
  const source = await read("scripts/uat/sam78-canonical-migration-history.txt");
  const crlfSource = source.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  assert.equal(parseMigrationHistoryManifest(crlfSource).length, 148);
  assert.throws(
    () => parseMigrationHistoryManifest(source.replace("# schema-version=1", "# schema-version=2")),
    /header mismatch/,
  );
  assert.throws(
    () => parseMigrationHistoryManifest(source.replace(/^(\d{14})\t/m, "$1 ")),
    /row is malformed/,
  );
  const lines = source.trimEnd().split("\n");
  const swapped = [...lines];
  [swapped[10], swapped[11]] = [swapped[11], swapped[10]];
  assert.throws(() => parseMigrationHistoryManifest(`${swapped.join("\n")}\n`), /strictly ordered/);
  assert.throws(
    () => parseMigrationHistoryManifest(source.replace("v4_tenant_lifecycle_closure", "v4_wrong_tip")),
    /exact canonical history tip/,
  );
});

test("SQL parser handles CRLF, nested comments, dollar blocks, and escaped strings", () => {
  const sample = [
    "/* outer /* nested ; */ end */",
    "BEGIN;",
    String.raw`SELECT E'escaped\';still';`,
    String.raw`SELECT U&"identifier\0061;tail";`,
    "DO $body$ BEGIN PERFORM ';'; END $body$;",
    "COMMIT;",
    "",
  ].join("\r\n");
  const body = stripOuterTransaction(sample, "sample");
  assert.equal(body.length, 3);
  assert.match(body[0], /^SELECT E'/);
  assert.match(body[1], /^SELECT U&"/);
  assert.match(body[2], /^DO \$body\$/);
});

test("SQL parser rejects malformed comments, quotes, and transaction envelopes", () => {
  assert.throws(() => stripOuterTransaction("SELECT 1; COMMIT;", "missing"), /must start/);
  assert.throws(() => stripOuterTransaction("BEGIN; SELECT 1;", "missing"), /must end/);
  assert.throws(
    () => stripOuterTransaction("BEGIN; BEGIN; SELECT 1; COMMIT; COMMIT;", "nested"),
    /unexpected top-level/,
  );
  assert.throws(() => splitSqlStatements("/* outer /* nested */"), /unterminated/);
  assert.throws(() => splitSqlStatements("BEGIN; SELECT E'unclosed\\'; COMMIT;"), /unterminated/);
  assert.throws(() => splitSqlStatements("BEGIN; DO $x$ SELECT 1; COMMIT;"), /unterminated/);
});

test("platform staff role mapping is canonical, bounded, and fail closed", () => {
  const mapping = {
    "78000000-0099-4000-8000-000000000099": "platform_support",
    "78000000-0011-4000-8000-000000000011": "platform_owner",
  };
  assert.equal(
    parsePlatformStaffRoleMapping(JSON.stringify(mapping)),
    '{"78000000-0011-4000-8000-000000000011":"platform_owner","78000000-0099-4000-8000-000000000099":"platform_support"}',
  );
  assert.equal(
    PLATFORM_STAFF_ROLE_MAPPING_FILE,
    "/etc/newme-staging/sam78-platform-staff-role-mapping.json",
  );
  assert.throws(() => parsePlatformStaffRoleMapping("[]"), /must be an object/);
  assert.throws(() => parsePlatformStaffRoleMapping("{"), /not valid JSON/);
  assert.throws(
    () => parsePlatformStaffRoleMapping('{"not-a-uuid":"platform_owner"}'),
    /entry is invalid/,
  );
  assert.throws(
    () => parsePlatformStaffRoleMapping('{"78000000-0011-4000-8000-000000000011":"admin"}'),
    /entry is invalid/,
  );
});

test("apply is one bounded transaction with try-lock, history lock, and pre/post verification", async () => {
  const loaded = await plan();
  const sql = buildTransactionSql({
    action: "apply",
    plan: loaded,
    expectedHistory: await expectedHistory(),
    platformStaffRoleMapping: "{}",
    verifySql: await read("scripts/uat/sam78-staging-migration-verify.sql"),
  });
  const top = splitSqlStatements(sql);
  assert.equal(top[0], "BEGIN");
  assert.equal(top.at(-1), "COMMIT");
  assert.equal(top.filter((statement) => statement === "BEGIN").length, 1);
  assert.equal(top.filter((statement) => statement === "COMMIT").length, 1);
  assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(sql, /SET LOCAL statement_timeout = '15min'/);
  assert.match(sql, /pg_try_advisory_xact_lock\(hashtextextended/);
  assert.match(sql, /LOCK TABLE supabase_migrations\.schema_migrations IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql, /SET LOCAL newme\.platform_staff_role_mapping = '\{\}'/);
  assert.ok(
    sql.indexOf("verify_phase = 'pre'")
      < sql.indexOf("INSERT INTO supabase_migrations.schema_migrations"),
  );
  assert.ok(
    sql.lastIndexOf("verify_phase = 'post'")
      > sql.lastIndexOf("INSERT INTO supabase_migrations.schema_migrations"),
  );
  assert.match(sql, /complete migration history does not match canonical predecessor state/);
  assert.match(sql, /complete migration history verification failed/);
  assert.doesNotMatch(sql, /ON CONFLICT\s*\(\s*version\s*\)/i);
  assert.doesNotMatch(sql, /ON CONFLICT\s+ON CONSTRAINT\s+schema_migrations/i);
});

test("audited staging gap omits only its active rows from predecessor history", async () => {
  const loaded = await plan();
  const applied = loaded.filter(({ version }) => KNOWN_STAGING_APPLIED_VERSIONS.includes(version));
  const { activePlan: activeVersions } = resolveStagingApplyPlan(applied);
  const activePlan = bindMigrationPlanEntries(loaded, activeVersions);
  const sql = buildTransactionSql({
    action: "apply",
    plan: loaded,
    activePlan,
    expectedHistory: await expectedHistory(),
    platformStaffRoleMapping: "{}",
    verifySql: await read("scripts/uat/sam78-staging-migration-verify.sql"),
  });
  assert.match(sql, /newme\.sam78_apply_mode = 'known_gap'/);
  assert.match(sql, /20260804185311/);
  assert.match(sql, /20260803100000/);
  assert.doesNotMatch(
    sql.slice(sql.indexOf("DO $sam78_preflight$"), sql.indexOf("SET LOCAL newme.sam78_verify_phase = 'pre'")),
    /\('20260804185311', 'sam80_shared_operational_services'\)/,
  );
  assert.deepEqual(
    Object.keys(KNOWN_STAGING_APPLIED_HISTORY_SHA256),
    KNOWN_STAGING_APPLIED_VERSIONS,
  );
  assert.match(sql, /extensions\.digest\(convert_to\(array_to_string\(statements, E'\\x1f'\), 'UTF8'\), 'sha256'\)/);
  assert.match(sql, /a500bf378c6b26690fcc2c8e8f86cba17efbc7f48fd7e517e4e4dfdf5e75dd73/);
});

test("executor binds resolved staging versions to parsed SQL entries before generation", async () => {
  const loaded = await plan();
  const resolved = resolveStagingApplyPlan(
    loaded.filter(({ version }) => KNOWN_STAGING_APPLIED_VERSIONS.includes(version)),
  );
  const activePlan = bindMigrationPlanEntries(loaded, resolved.activePlan);
  assert.equal(activePlan.length, 8);
  assert.ok(activePlan.every((item) => Array.isArray(item.statements) && item.statements.length > 0));
  assert.throws(
    () => bindMigrationPlanEntries(loaded, [...resolved.activePlan].reverse()),
    /ordered canonical subset/,
  );
});

test("rollback reverses the exact plan and verifies the applied prestate", async () => {
  const loaded = await plan();
  const sql = buildTransactionSql({
    action: "rollback",
    plan: loaded,
    expectedHistory: await expectedHistory(),
    verifySql: await read("scripts/uat/sam78-staging-migration-verify.sql"),
  });
  const operations = sql.indexOf("DELETE FROM supabase_migrations.schema_migrations");
  const syntheticCleanupFix = sql.indexOf("version = '20260806020000'", operations);
  const paidSeatFix = sql.indexOf("version = '20260806010000'", operations);
  const sam84 = sql.indexOf("version = '20260806000000'", operations);
  const newest = sql.indexOf("version = '20260805190000'", sam84 + 1);
  const sam83 = sql.indexOf("version = '20260805130000'", newest + 1);
  const sam82 = sql.indexOf("version = '20260805120000'", sam83 + 1);
  const exitDigest = sql.indexOf("version = '20260805010000'", sam82 + 1);
  const productCleanup = sql.indexOf("version = '20260805000000'", exitDigest + 1);
  const sam20Cleanup = sql.indexOf("version = '20260804193000'", productCleanup + 1);
  const sam80Operations = sql.indexOf("version = '20260804185311'", sam20Cleanup + 1);
  const sam26Cleanup = sql.indexOf("version = '20260804165734'", sam80Operations + 1);
  const governedRpc = sql.indexOf("version = '20260804153000'", sam26Cleanup + 1);
  const middle = sql.indexOf("version = '20260803143000'", governedRpc + 1);
  const oldest = sql.indexOf("version = '20260803100000'", middle + 1);
  assert.ok(
    operations > 0 && syntheticCleanupFix > operations && paidSeatFix > syntheticCleanupFix && sam84 > paidSeatFix && newest > sam84 && sam83 > newest && sam82 > sam83 && exitDigest > sam82 && productCleanup > exitDigest
      && sam20Cleanup > productCleanup
      && sam80Operations > sam20Cleanup
      && sam26Cleanup > sam80Operations
      && governedRpc > sam26Cleanup
      && middle > governedRpc && oldest > middle,
  );
  assert.match(sql, /v4_assert_tenant_closure_rollback_safe/);
  assert.match(sql, /SAM78 rollback history cleanup failed/);
  assert.equal(splitSqlStatements(sql).at(-1), "COMMIT");
});

test("apply accepts the exact audited non-contiguous staging history and applies only its canonical gaps", async () => {
  const loaded = await plan();
  const knownApplied = loaded.filter(({ version }) => KNOWN_STAGING_APPLIED_VERSIONS.includes(version));
  const activePlan = loaded.filter(({ version }) => !KNOWN_STAGING_APPLIED_VERSIONS.includes(version));
  assert.deepEqual(
    activePlan.map(({ version }) => version),
    [
      "20260804185311",
      "20260805020000",
      "20260805120000",
      "20260805130000",
      "20260805190000",
      "20260806000000",
      "20260806010000",
      "20260806020000",
    ],
  );
  const sql = buildTransactionSql({
    action: "apply",
    plan: loaded,
    activePlan,
    expectedHistory: await expectedHistory(),
    platformStaffRoleMapping: "{}",
    verifySql: await read("scripts/uat/sam78-staging-migration-verify.sql"),
  });
  assert.match(sql, /newme\.sam78_apply_mode = 'known_gap'/);
  assert.match(sql, /20260804185311/);
  assert.match(sql, /20260806000000/);
  assert.match(sql, /20260806010000/);
  assert.match(sql, /20260806020000/);
  assert.match(sql, /SAM78 known applied migration metadata mismatch/);
  assert.equal(
    (sql.match(/INSERT INTO supabase_migrations\.schema_migrations/g) ?? []).length,
    activePlan.length,
  );
  assert.doesNotMatch(
    sql.slice(sql.indexOf("SET LOCAL newme.sam78_verify_phase = 'pre'")),
    /CREATE TABLE public\.capabilities/,
  );
  assert.deepEqual(parseAppliedMigrationSet("").map(({ version }) => version), []);
  assert.deepEqual(
    parseAppliedMigrationSet(
      knownApplied.map(({ version, name }) => `${version}\t${name}`).join("\n") + "\n",
    ).map(({ version }) => version),
    KNOWN_STAGING_APPLIED_VERSIONS,
  );
  assert.deepEqual(
    resolveStagingApplyPlan(knownApplied).activePlan.map(({ version }) => version),
    activePlan.map(({ version }) => version),
  );
  assert.throws(
    () => resolveStagingApplyPlan([loaded[1]]),
    /exact known staging migration set, or a canonical applied prefix/,
  );
  const manifest = await expectedHistory();
  assert.throws(
    () => buildTransactionSql({
      action: "apply",
      plan: loaded,
      activePlan: loaded.slice(0, 1),
      expectedHistory: manifest,
      platformStaffRoleMapping: "{}",
      verifySql: "SELECT 1;",
    }),
    /exact known staging migration set, or a canonical applied prefix/,
  );

  const contiguousApplied = loaded.slice(0, -1);
  const contiguousResolution = resolveStagingApplyPlan(contiguousApplied);
  assert.deepEqual(
    contiguousResolution.activePlan.map(({ version }) => version),
    ["20260806020000"],
  );
  const incrementalSql = buildTransactionSql({
    action: "apply",
    plan: loaded,
    activePlan: bindMigrationPlanEntries(loaded, contiguousResolution.activePlan),
    expectedHistory: manifest,
    platformStaffRoleMapping: "{}",
    verifySql: "SELECT 1;",
  });
  assert.equal(
    (incrementalSql.match(/INSERT INTO supabase_migrations\.schema_migrations/g) ?? []).length,
    1,
  );
  assert.match(incrementalSql, /newme\.sam78_apply_mode = 'suffix'/);
  assert.match(
    incrementalSql,
    /83f850a755f3eb7651cf9e1ef202bb791300b60978f373007dfcec1691297320/,
  );
  assert.match(
    incrementalSql,
    /version = '20260805020000'[\s\S]*?statements IS NOT DISTINCT FROM ARRAY\[/,
  );
});

test("plan, action, history, and verification drift fail closed before execution", async () => {
  const loaded = await plan();
  const history = await expectedHistory();
  assert.throws(
    () => buildTransactionSql({ action: "repair", plan: loaded, expectedHistory: history, verifySql: "SELECT 1;" }),
    /action must be apply or rollback/,
  );
  assert.throws(
    () => buildTransactionSql({ action: "apply", plan: loaded.slice(0, 1), expectedHistory: history, verifySql: "SELECT 1;" }),
    /exact SAM-78 versions/,
  );
  assert.throws(
    () => buildTransactionSql({
      action: "apply",
      plan: [{ ...loaded[0], version: "20260803100001" }, ...loaded.slice(1)],
      expectedHistory: history,
      verifySql: "SELECT 1;",
    }),
    /version or name drift/,
  );
  assert.throws(
    () => buildTransactionSql({ action: "apply", plan: loaded, expectedHistory: history.slice(0, -1), verifySql: "SELECT 1;" }),
    /exact canonical history tip/,
  );
  assert.throws(
    () => buildTransactionSql({ action: "apply", plan: loaded, expectedHistory: history, verifySql: "" }),
    /verification SQL is empty/,
  );
  assert.throws(
    () => buildTransactionSql({ action: "apply", plan: loaded, expectedHistory: history, verifySql: "SELECT 1;" }),
    /platform staff role mapping is required/,
  );
});

test("psql uses fixed owner, root-only secret path, and verify-full CA without secret arguments", () => {
  const secretPath = "/etc/newme-staging/staging-migration.pgpass";
  const invocation = psqlInvocation({ SAM78_PGPASS_PATH: secretPath });
  assert.equal(invocation.command, "/usr/bin/psql");
  assert.ok(invocation.args.includes(`postgres.${STAGING_REF}`));
  assert.equal(invocation.env.PGPASSFILE, secretPath);
  assert.equal(invocation.env.PGSSLMODE, "verify-full");
  assert.equal(invocation.env.PGSSLROOTCERT, CA_FILE);
  assert.ok(!invocation.args.includes(secretPath));
  assert.ok(!JSON.stringify(invocation.args).includes("password"));
  assert.ok(!JSON.stringify(invocation).includes("sam21-db.pgpass"));
  const historyInvocation = psqlHistoryInvocation({ SAM78_PGPASS_PATH: secretPath });
  assert.ok(historyInvocation.args.includes("--tuples-only"));
  assert.ok(historyInvocation.args.includes("--no-align"));
  assert.match(historyInvocation.args.at(-1), /schema_migrations/);
  assert.ok(!JSON.stringify(historyInvocation.args).includes(secretPath));
});

test("live verifier covers exact pre/post FK, RLS, ACL, backfill, orphan, and rollback contracts", async () => {
  const [verify, migration, sam80Migration] = await Promise.all([
    read("scripts/uat/sam78-staging-migration-verify.sql"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("supabase/migrations/20260804185311_sam80_shared_operational_services.sql"),
  ]);
  for (const evidence of [
    "newme.sam78_verify_phase",
    "_organization_id_fkey",
    "constraint_row.convalidated",
    "relation.relforcerowsecurity",
    "v4_tenant_read_gate",
    "tenant backfill/orphan verification failed",
    "zero UUID tenant backfill",
    "has_table_privilege",
    "has_function_privilege",
    "search_path=pg_catalog, public, pg_temp",
    "v4_assert_tenant_closure_rollback_safe",
    "'full', 'suffix', 'known_gap'",
    "known-gap prestate already contains missing migration relation",
    "SAM79 paid-seat trigger record-shape fix is missing",
    "to_regclass('supabase_migrations.schema_migrations') IS NOT NULL",
  ]) assert.ok(verify.includes(evidence), `missing live verifier evidence: ${evidence}`);

  const normalizedMigration = `${migration}\n${sam80Migration}`.replaceAll(/\s+/g, "");
  const verifierSignatures = new Set(
    [...verify.matchAll(/'(public\.v4_[a-z0-9_]+\([^']+\))'/g)]
      .map((match) => match[1]),
  );
  for (const signature of verifierSignatures) {
    assert.ok(
      normalizedMigration.includes(signature.replaceAll(/\s+/g, "")),
      `live verifier function signature is not canonical: ${signature}`,
    );
  }
});

test("paid-seat trigger fix and rollback are transaction-bounded and restore the exact predecessor body", async () => {
  const [migration, rollback, predecessor] = await Promise.all([
    read("supabase/migrations/20260806010000_v4_fix_membership_paid_seat_trigger.sql"),
    read("supabase/rollback/20260806010000_v4_fix_membership_paid_seat_trigger_rollback.sql"),
    read("supabase/migrations/20260805190000_v4_commercial_control_plane.sql"),
  ]);
  assert.deepEqual(splitSqlStatements(migration).map((statement) => statement.trim()).at(0), "BEGIN");
  assert.deepEqual(splitSqlStatements(migration).map((statement) => statement.trim()).at(-1), "COMMIT");
  assert.match(migration, /v4_paid_seat_trigger_predecessor_drift/);
  assert.match(migration, /IF TG_TABLE_NAME = 'memberships' THEN/);
  assert.match(migration, /target_membership_id := COALESCE\(NEW\.id, OLD\.id\)/);
  assert.match(migration, /COALESCE\(NEW\.membership_id, OLD\.membership_id\)/);
  assert.equal(splitSqlStatements(rollback).at(0).trim(), "BEGIN");
  assert.equal(splitSqlStatements(rollback).at(-1).trim(), "COMMIT");
  assert.match(rollback, /v4_paid_seat_trigger_rollback_requires_staging_or_test/);
  assert.match(rollback, /v4_paid_seat_trigger_rollback_predecessor_drift/);
  const predecessorStart = predecessor.indexOf("CREATE OR REPLACE FUNCTION public.v4_sync_membership_paid_seat()");
  const predecessorEnd = predecessor.indexOf("$$;", predecessorStart) + 3;
  const rollbackStart = rollback.indexOf("CREATE OR REPLACE FUNCTION public.v4_sync_membership_paid_seat()");
  const rollbackEnd = rollback.indexOf("$$;", rollbackStart) + 3;
  assert.equal(
    rollback.slice(rollbackStart, rollbackEnd).replaceAll("\r\n", "\n"),
    predecessor.slice(predecessorStart, predecessorEnd).replaceAll("\r\n", "\n"),
  );
});
