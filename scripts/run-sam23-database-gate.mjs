#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const PASSWORD = "sam23-disposable-only";
const DATABASE = "sam23";
const ORGANIZATION_TABLES = [
  "quotations",
  "contracts",
  "contract_approvals",
  "installment_plans",
  "payments",
  "payment_allocations",
  "projects",
  "tasks",
  "lead_documents",
];

function command(args, options = {}) {
  return spawnSync(process.env.SAM23_DOCKER_BIN || "docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 240_000,
    ...options,
  });
}

function combined(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(`${label}_failed:${combined(result) || "unknown"}`);
  }
  return result;
}

function psql(container, args, environmentName, database = DATABASE) {
  const environment = ["-e", `PGPASSWORD=${PASSWORD}`];
  if (environmentName) {
    environment.push(
      "-e",
      `PGOPTIONS=-cnewme.environment=${environmentName}`,
    );
  }
  return command([
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
    database,
    ...args,
  ]);
}

async function copyFixture(container, relativePath) {
  const destination = `/work/${relativePath.replaceAll("\\", "/")}`;
  const parent = destination.slice(0, destination.lastIndexOf("/"));
  requireSuccess(command(["exec", container, "mkdir", "-p", parent]), "sam23_mkdir");
  requireSuccess(
    command(["cp", resolve(ROOT, relativePath), `${container}:${destination}`]),
    `sam23_copy_${relativePath}`,
  );
}

function requireTypeTokens(source) {
  for (const tableName of ORGANIZATION_TABLES) {
    const tableMarker = `      ${tableName}: {`;
    const start = source.indexOf(tableMarker);
    if (start < 0) throw new Error(`sam23_type_table_missing:${tableName}`);
    const remainder = source.slice(start + tableMarker.length);
    const nextTableMatch = /^      [A-Za-z0-9_]+: \{$/m.exec(remainder);
    const nextTable = nextTableMatch
      ? start + tableMarker.length + nextTableMatch.index
      : -1;
    const block = source.slice(
      start,
      nextTable < 0 ? source.length : nextTable,
    );
    for (const token of [
      "organization_id: string",
      "organization_id?: string",
      `foreignKeyName: "${tableName}_organization_id_fkey"`,
    ]) {
      if (!block.includes(token)) {
        throw new Error(`sam23_type_token_missing:${tableName}:${token}`);
      }
    }
  }

  for (const tableName of [
    "roles",
    "membership_roles",
    "organization_provisioning_requests",
  ]) {
    if (!source.includes(`      ${tableName}: {`)) {
      throw new Error(`sam23_type_table_missing:${tableName}`);
    }
  }
  if (!source.includes(
    "organization_billable_seat_count: {",
  ) || !source.includes(
    "initialize_organization: {",
  ) || !source.includes(
    "provision_organization_member: {",
  ) || !source.includes(
    "v_sam23_organization_commercial_summary: {",
  )) {
    throw new Error("sam23_type_api_contract_missing");
  }
}

async function main() {
  const container =
    `newme-sam23-db-${process.pid}-${randomUUID().slice(0, 8)}`;
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
      `POSTGRES_DB=${DATABASE}`,
      POSTGRES_IMAGE,
    ]), "sam23_postgres_start");
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
        DATABASE,
      ], { timeout: 10_000 });
      if (!result.error && result.status === 0) {
        ready = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!ready) throw new Error("sam23_postgres_not_ready");

    for (const relativePath of [
      "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
      "supabase/migrations/20260730231446_sam23_organization_owned_commercial_core.sql",
      "supabase/migrations/20260731015812_sam23_govern_billable_seat_rpcs.sql",
      "supabase/migrations/20260801023000_sam25_allow_rls_safe_commercial_updates.sql",
      "supabase/migrations/20260801025500_sam25_sync_project_paid_amount.sql",
      "supabase/migrations/20260801120000_commercial_p0_seat_role_integrity.sql",
      "supabase/migrations/20260801184548_replace_time_relative_tasks_constraint.sql",
      "supabase/migrations/20260801202728_organization_customer_exit_lifecycle.sql",
      "supabase/migrations/20260802055200_multitenant_auth_activity_context.sql",
      "supabase/migrations/20260802064000_organization_lifecycle_cascade_context.sql",
      "supabase/migrations/20260802074500_fix_customer_export_notification_uuid.sql",
      "supabase/migrations/20260803100000_v4_tenant_capability_boundary.sql",
      "supabase/rollback/20260730231446_sam23_organization_owned_commercial_core_rollback.sql",
      "supabase/rollback/20260801120000_commercial_p0_seat_role_integrity_rollback.sql",
      "supabase/rollback/20260801202728_organization_customer_exit_lifecycle_rollback.sql",
      "supabase/rollback/20260802055200_multitenant_auth_activity_context_rollback.sql",
      "supabase/rollback/20260802064000_organization_lifecycle_cascade_context_rollback.sql",
      "supabase/rollback/20260802074500_fix_customer_export_notification_uuid_rollback.sql",
      "supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql",
      "tests/database/sam23-organization-commercial-core.sql",
      "tests/database/sam23-organization-commercial-rollback-verify.sql",
      "tests/database/commercial-p0-seat-role-integrity.sql",
      "tests/database/tasks-restorable-due-constraint.sql",
      "tests/database/tasks-restorable-due-cleanup.sql",
      "tests/database/organization-customer-exit-prelude.sql",
      "tests/database/organization-customer-exit.sql",
      "tests/database/multitenant-auth-activity-context.sql",
      "tests/database/organization-lifecycle-cascade-context.sql",
      "tests/database/v4-tenant-capability-boundary.sql",
      "tests/database/v4-tenant-capability-expand-compatibility.sql",
      "tests/database/v4-tenant-capability-rollback-guard.sql",
      "tests/database/v4-tenant-capability-rollback-guard-cleanup.sql",
    ]) {
      await copyFixture(container, relativePath);
    }

    requireSuccess(
      psql(container, ["-f", "sam23-organization-commercial-core.sql"]),
      "sam23_apply_harness",
    );

    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260801184548_replace_time_relative_tasks_constraint.sql",
      ]),
      "task_due_constraint_apply",
    );
    requireSuccess(
      psql(container, ["-f", "tasks-restorable-due-constraint.sql"]),
      "task_due_constraint_fixture",
    );

    const backupPath = "/tmp/sam23-restorable.dump";
    const restoredDatabase = "sam23_restore";
    requireSuccess(command([
      "exec",
      "-e",
      `PGPASSWORD=${PASSWORD}`,
      container,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      DATABASE,
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file",
      backupPath,
    ]), "task_backup_dump");
    requireSuccess(command([
      "exec",
      "-e",
      `PGPASSWORD=${PASSWORD}`,
      container,
      "createdb",
      "-U",
      "postgres",
      restoredDatabase,
    ]), "task_backup_target_create");
    requireSuccess(command([
      "exec",
      "-e",
      `PGPASSWORD=${PASSWORD}`,
      container,
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      restoredDatabase,
      "--exit-on-error",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      backupPath,
    ]), "task_backup_restore");
    const restoredTask = requireSuccess(
      psql(
        container,
        [
          "-A",
          "-t",
          "-q",
          "-c",
          `SELECT json_build_object(
            'overdue_rows', count(*) FILTER (
              WHERE due_at = timestamptz '2020-01-02 09:00:00+00'
            ),
            'constraint', (
              SELECT pg_get_constraintdef(oid, true)
              FROM pg_constraint
              WHERE conrelid = 'public.tasks'::regclass
                AND conname = 'tasks_future_only'
            )
          )
          FROM public.tasks`,
        ],
        undefined,
        restoredDatabase,
      ),
      "task_backup_restore_verify",
    );
    const restoredTaskContract = JSON.parse(restoredTask.stdout.trim());
    if (
      restoredTaskContract.overdue_rows !== 1
      || restoredTaskContract.constraint
        !== "CHECK (due_at > (created_at - '1 day'::interval))"
    ) {
      throw new Error(
        `task_backup_restore_contract_mismatch:${restoredTask.stdout.trim()}`,
      );
    }
    requireSuccess(
      psql(container, ["-f", "tasks-restorable-due-cleanup.sql"]),
      "task_backup_fixture_cleanup",
    );

    const schema = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        `SELECT json_build_object(
          'organization_columns', (
            SELECT count(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('${ORGANIZATION_TABLES.join("','")}')
              AND column_name = 'organization_id'
              AND is_nullable = 'NO'
          ),
          'composite_foreign_keys', (
            SELECT count(*)
            FROM pg_constraint
            WHERE contype = 'f'
              AND connamespace = 'public'::regnamespace
              AND array_length(conkey, 1) = 2
              AND conname LIKE '%organization%_fkey'
          ),
          'security_invoker', (
            SELECT COALESCE(array_to_string(reloptions, ','), '')
            FROM pg_class
            WHERE oid =
              'public.v_sam23_organization_commercial_summary'::regclass
          )
        )`,
      ]),
      "sam23_schema_contract",
    );
    const schemaContract = JSON.parse(schema.stdout.trim());
    if (
      schemaContract.organization_columns !== ORGANIZATION_TABLES.length
      || schemaContract.composite_foreign_keys < 12
      || !schemaContract.security_invoker.includes("security_invoker=true")
    ) {
      throw new Error(`sam23_schema_contract_mismatch:${schema.stdout.trim()}`);
    }

    const typesSource = await readFile(
      resolve(ROOT, "src/types/database.ts"),
      "utf8",
    );
    requireTypeTokens(typesSource);

    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260801120000_commercial_p0_seat_role_integrity.sql",
      ]),
      "commercial_p0_apply",
    );
    requireSuccess(
      psql(container, ["-f", "commercial-p0-seat-role-integrity.sql"]),
      "commercial_p0_fixture",
    );

    requireSuccess(
      psql(container, ["-f", "organization-customer-exit-prelude.sql"]),
      "organization_exit_prelude",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260801202728_organization_customer_exit_lifecycle.sql",
      ]),
      "organization_exit_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260802074500_fix_customer_export_notification_uuid.sql",
      ]),
      "customer_export_notification_uuid_apply",
    );
    requireSuccess(
      psql(container, ["-f", "organization-customer-exit.sql"]),
      "organization_exit_fixture",
    );

    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260802055200_multitenant_auth_activity_context.sql",
      ]),
      "multitenant_auth_activity_apply",
    );
    requireSuccess(
      psql(container, ["-f", "multitenant-auth-activity-context.sql"]),
      "multitenant_auth_activity_fixture",
    );

    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260802064000_organization_lifecycle_cascade_context.sql",
      ]),
      "organization_lifecycle_cascade_apply",
    );
    requireSuccess(
      psql(container, ["-f", "organization-lifecycle-cascade-context.sql"]),
      "organization_lifecycle_cascade_fixture",
    );

    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260803100000_v4_tenant_capability_boundary.sql",
      ]),
      "v4_tenant_capability_expand_apply",
    );
    requireSuccess(
      psql(container, ["-f", "v4-tenant-capability-expand-compatibility.sql"]),
      "v4_tenant_capability_expand_compatibility_fixture",
    );

    requireSuccess(
      psql(container, ["-f", "v4-tenant-capability-boundary.sql"]),
      "v4_tenant_capability_fixture",
    );

    requireSuccess(
      psql(container, ["-f", "v4-tenant-capability-rollback-guard.sql"]),
      "v4_tenant_capability_rollback_guard_fixture",
    );
    const deniedNonlegacyV4CapabilityRollback = psql(
      container,
      [
        "-f",
        "/work/supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql",
      ],
      "test",
    );
    if (
      deniedNonlegacyV4CapabilityRollback.status === 0
      || !combined(deniedNonlegacyV4CapabilityRollback).includes(
        "v4_tenant_capability_expand_rollback_nonlegacy_products_present",
      )
    ) {
      throw new Error("v4_tenant_capability_nonlegacy_rollback_not_fail_closed");
    }
    const v4CapabilityStillApplied = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regclass('public.capabilities') IS NOT NULL AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'products' AND policyname LIKE 'v4_products_capability_%') = 4",
      ]),
      "v4_tenant_capability_failed_rollback_atomicity",
    );
    if (v4CapabilityStillApplied.stdout.trim() !== "t") {
      throw new Error("v4_tenant_capability_failed_rollback_changed_schema");
    }
    requireSuccess(
      psql(container, ["-f", "v4-tenant-capability-rollback-guard-cleanup.sql"]),
      "v4_tenant_capability_rollback_guard_cleanup",
    );

    const deniedV4CapabilityExpandRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql",
    ]);
    if (
      deniedV4CapabilityExpandRollback.status === 0
      || !combined(deniedV4CapabilityExpandRollback).includes(
        "v4_tenant_capability_expand_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("v4_tenant_capability_expand_rollback_fail_closed_contract_failed");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql",
        ],
        "test",
      ),
      "v4_tenant_capability_expand_rollback",
    );
    const v4CapabilityExpandRolledBack = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regclass('public.capabilities') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'organization_id') AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'products' AND policyname IN ('policy_products_select_admin','policy_products_select_finance','policy_products_select_designer','policy_products_select_sales','policy_products_insert_admin','policy_products_update_admin','policy_products_delete_admin')) = 7 AND NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.products'::regclass)",
      ]),
      "v4_tenant_capability_expand_rollback_verify",
    );
    if (v4CapabilityExpandRolledBack.stdout.trim() !== "t") {
      throw new Error("v4_tenant_capability_expand_rollback_incomplete");
    }

    const deniedCascadeRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260802064000_organization_lifecycle_cascade_context_rollback.sql",
    ]);
    if (
      deniedCascadeRollback.status === 0
      || !combined(deniedCascadeRollback).includes(
        "organization_lifecycle_cascade_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error(
        `organization_lifecycle_cascade_rollback_fail_closed_contract_failed:${combined(deniedCascadeRollback)}`,
      );
    }
    const cascadeStillApplied = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT position('pg_trigger_depth() > 1' in pg_get_functiondef('public.organization_lifecycle_write_guard()'::regprocedure)) > 0",
      ]),
      "organization_lifecycle_cascade_failed_rollback_atomicity",
    );
    if (cascadeStillApplied.stdout.trim() !== "t") {
      throw new Error("organization_lifecycle_cascade_failed_rollback_changed_schema");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260802064000_organization_lifecycle_cascade_context_rollback.sql",
        ],
        "test",
      ),
      "organization_lifecycle_cascade_rollback",
    );
    const cascadeRolledBack = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT position('pg_trigger_depth() > 1' in pg_get_functiondef('public.organization_lifecycle_write_guard()'::regprocedure)) = 0",
      ]),
      "organization_lifecycle_cascade_rollback_verify",
    );
    if (cascadeRolledBack.stdout.trim() !== "t") {
      throw new Error("organization_lifecycle_cascade_rollback_incomplete");
    }

    const deniedAuthActivityRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260802055200_multitenant_auth_activity_context_rollback.sql",
    ]);
    if (
      deniedAuthActivityRollback.status === 0
      || !combined(deniedAuthActivityRollback).includes(
        "multitenant_auth_activity_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error(
        `multitenant_auth_activity_rollback_fail_closed_contract_failed:${combined(deniedAuthActivityRollback)}`,
      );
    }
    const authActivityStillApplied = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regclass('public.user_session_daily_tenant_user_session_date_key') IS NOT NULL",
      ]),
      "multitenant_auth_activity_failed_rollback_atomicity",
    );
    if (authActivityStillApplied.stdout.trim() !== "t") {
      throw new Error("multitenant_auth_activity_failed_rollback_changed_schema");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260802055200_multitenant_auth_activity_context_rollback.sql",
        ],
        "test",
      ),
      "multitenant_auth_activity_rollback",
    );

    const deniedCustomerExportUuidRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260802074500_fix_customer_export_notification_uuid_rollback.sql",
    ]);
    if (
      deniedCustomerExportUuidRollback.status === 0
      || !combined(deniedCustomerExportUuidRollback).includes(
        "customer_export_notification_uuid_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error(
        `customer_export_notification_uuid_rollback_fail_closed_contract_failed:${combined(deniedCustomerExportUuidRollback)}`,
      );
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260802074500_fix_customer_export_notification_uuid_rollback.sql",
        ],
        "test",
      ),
      "customer_export_notification_uuid_rollback",
    );

    const deniedOrganizationExitRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260801202728_organization_customer_exit_lifecycle_rollback.sql",
    ]);
    if (
      deniedOrganizationExitRollback.status === 0
      || !combined(deniedOrganizationExitRollback).includes(
        "organization_exit_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error(
        `organization_exit_rollback_fail_closed_contract_failed:${combined(deniedOrganizationExitRollback)}`,
      );
    }
    const organizationExitStillApplied = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regclass('public.organization_exit_requests')::text",
      ]),
      "organization_exit_failed_rollback_atomicity",
    );
    if (organizationExitStillApplied.stdout.trim() !== "organization_exit_requests") {
      throw new Error("organization_exit_failed_rollback_changed_schema");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260801202728_organization_customer_exit_lifecycle_rollback.sql",
        ],
        "test",
      ),
      "organization_exit_rollback",
    );
    const organizationExitRemoved = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regclass('public.organization_exit_requests') IS NULL",
      ]),
      "organization_exit_rollback_verify",
    );
    if (organizationExitRemoved.stdout.trim() !== "t") {
      throw new Error("organization_exit_rollback_incomplete");
    }

    const deniedCommercialRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260801120000_commercial_p0_seat_role_integrity_rollback.sql",
    ]);
    if (
      deniedCommercialRollback.status === 0
      || !combined(deniedCommercialRollback).includes(
        "commercial_p0_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("commercial_p0_rollback_fail_closed_contract_failed");
    }
    const commercialRpcStillApplied = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regprocedure('public.provision_organization_member(uuid,uuid,text,uuid,text)')::text",
      ]),
      "commercial_p0_failed_rollback_atomicity",
    );
    if (!commercialRpcStillApplied.stdout.includes("provision_organization_member")) {
      throw new Error("commercial_p0_failed_rollback_changed_schema");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260801120000_commercial_p0_seat_role_integrity_rollback.sql",
        ],
        "test",
      ),
      "commercial_p0_rollback",
    );

    const deniedRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260730231446_sam23_organization_owned_commercial_core_rollback.sql",
    ]);
    if (
      deniedRollback.status === 0
      || !combined(deniedRollback).includes(
        "sam23_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("sam23_rollback_fail_closed_contract_failed");
    }

    const stillApplied = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regclass('public.roles')::text",
      ]),
      "sam23_failed_rollback_atomicity",
    );
    if (stillApplied.stdout.trim() !== "roles") {
      throw new Error("sam23_failed_rollback_changed_schema");
    }

    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260730231446_sam23_organization_owned_commercial_core_rollback.sql",
        ],
        "test",
      ),
      "sam23_rollback",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "sam23-organization-commercial-rollback-verify.sql",
      ]),
      "sam23_rollback_verify",
    );

    process.stdout.write(`${JSON.stringify({
      status: "passed",
      image: POSTGRES_IMAGE,
      initialization_idempotency: "verified",
      billable_seats: "verified",
      commercial_seat_tiers: "verified",
      atomic_membership_roles: "verified",
      organization_columns: ORGANIZATION_TABLES.length,
      composite_foreign_keys: schemaContract.composite_foreign_keys,
      rls_and_report: "verified",
      type_contract: "verified",
      rollback_fail_closed: "verified",
      rollback: "verified",
      task_backup_restore: "verified",
      task_backup_fixture_cleanup: "verified",
      organization_customer_exit: "verified",
      organization_exit_rollback: "verified",
      organization_lifecycle_cascade: "verified",
      v4_tenant_capabilities: "verified",
      v4_product_catalog_isolation: "verified",
      fixture_cleanup: "verified",
    })}\n`);
  } finally {
    if (started) {
      const cleanup = command(["rm", "--force", container]);
      if (cleanup.error || cleanup.status !== 0) {
        process.stderr.write(
          `sam23_disposable_cleanup_failed:${combined(cleanup)}\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
