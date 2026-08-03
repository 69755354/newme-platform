import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  CA_FILE,
  CANONICAL_BASE_SHA,
  DATABASE_USER,
  MIGRATIONS,
  PLATFORM_STAFF_ROLE_MAPPING_FILE,
  STAGING_REF,
  buildTransactionSql,
  parseMigrationHistoryManifest,
  parsePlatformStaffRoleMapping,
  psqlInvocation,
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
  assert.deepEqual(
    manifest.map(({ version, name }) => `${version}_${name}.sql`),
    migrationFiles,
  );
  assert.deepEqual(manifest.slice(-2), paths.map(({ version, name }) => ({ version, name })));
});

test("migration history manifest accepts CRLF but rejects header, order, row, and tip drift", async () => {
  const source = await read("scripts/uat/sam78-canonical-migration-history.txt");
  assert.equal(parseMigrationHistoryManifest(source.replaceAll("\n", "\r\n")).length, 135);
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

test("rollback reverses the exact plan and verifies the applied prestate", async () => {
  const loaded = await plan();
  const sql = buildTransactionSql({
    action: "rollback",
    plan: loaded,
    expectedHistory: await expectedHistory(),
    verifySql: await read("scripts/uat/sam78-staging-migration-verify.sql"),
  });
  const operations = sql.indexOf("DELETE FROM supabase_migrations.schema_migrations");
  const newest = sql.indexOf("version = '20260803143000'", operations);
  const oldest = sql.indexOf("version = '20260803100000'", newest + 1);
  assert.ok(operations > 0 && newest > operations && oldest > newest);
  assert.match(sql, /v4_assert_tenant_closure_rollback_safe/);
  assert.match(sql, /SAM78 rollback history cleanup failed/);
  assert.equal(splitSqlStatements(sql).at(-1), "COMMIT");
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
    /exactly two versions/,
  );
  assert.throws(
    () => buildTransactionSql({
      action: "apply",
      plan: [{ ...loaded[0], version: "20260803100001" }, loaded[1]],
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
});

test("live verifier covers exact pre/post FK, RLS, ACL, backfill, orphan, and rollback contracts", async () => {
  const [verify, migration] = await Promise.all([
    read("scripts/uat/sam78-staging-migration-verify.sql"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
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
  ]) assert.ok(verify.includes(evidence), `missing live verifier evidence: ${evidence}`);

  const normalizedMigration = migration.replaceAll(/\s+/g, "");
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
