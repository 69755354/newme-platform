#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const PASSWORD = "sam23-disposable-only";
const DATABASE = "sam23";
const SAM78_GATE_PHASE = process.env.SAM78_GATE_PHASE || "full";
if (!new Set(["full", "apply", "fixture", "rollback"]).has(SAM78_GATE_PHASE)) {
  throw new Error(`invalid_sam78_gate_phase:${SAM78_GATE_PHASE}`);
}
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

function commandAsync(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.env.SAM23_DOCKER_BIN || "docker", args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolvePromise({ error, status: null, stdout, stderr });
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolvePromise({ status, stdout, stderr });
    });
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

function psqlAsync(container, sql) {
  return commandAsync([
    "exec", "-e", `PGPASSWORD=${PASSWORD}`, container,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
    "-d", DATABASE, "-c", sql,
  ]);
}

function verifySam78Live(container, action, phase) {
  return psql(
    container,
    [
      "-c",
      `SET newme.sam78_action = '${action}'; SET newme.sam78_verify_phase = '${phase}'; SET newme.sam78_apply_mode = 'full'; SET newme.sam78_active_start_version = '20260803100000'`,
      "-f",
      "/work/scripts/uat/sam78-staging-migration-verify.sql",
    ],
    "test",
  );
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
    const dockerRunArgs = [
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
    ];
    requireSuccess(command(dockerRunArgs), "sam23_postgres_start");
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
      "supabase/migrations/20260612000001_rpc_functions.sql",
      "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
      "supabase/migrations/20260730225759_sam14_platform_support_session_lifecycle.sql",
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
      "supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql",
      "supabase/migrations/20260804165734_sam26_synthetic_audit_cleanup_boundary.sql",
      "supabase/migrations/20260804185311_sam80_shared_operational_services.sql",
      "supabase/migrations/20260804193000_sam20_synthetic_support_cleanup_boundary.sql",
      "supabase/migrations/20260805000000_sam78_product_saas_synthetic_cleanup_boundary.sql",
      "supabase/migrations/20260805010000_sam78_v4_exit_digest_contract.sql",
      "supabase/migrations/20260806060000_sam78_product_saas_closed_cleanup_boundary.sql",
      "supabase/migrations/20260806070000_sam78_product_saas_inactive_audit_cleanup_boundary.sql",
      "supabase/migrations/20260805020000_sam81_real_estate_listing_foundation.sql",
      "supabase/migrations/20260805190000_v4_commercial_control_plane.sql",
      "supabase/rollback/20260730231446_sam23_organization_owned_commercial_core_rollback.sql",
      "supabase/rollback/20260801120000_commercial_p0_seat_role_integrity_rollback.sql",
      "supabase/rollback/20260801202728_organization_customer_exit_lifecycle_rollback.sql",
      "supabase/rollback/20260802055200_multitenant_auth_activity_context_rollback.sql",
      "supabase/rollback/20260802064000_organization_lifecycle_cascade_context_rollback.sql",
      "supabase/rollback/20260802074500_fix_customer_export_notification_uuid_rollback.sql",
      "supabase/rollback/20260803100000_v4_tenant_capability_boundary_rollback.sql",
      "supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql",
      "supabase/rollback/20260804165734_sam26_synthetic_audit_cleanup_boundary_rollback.sql",
      "supabase/rollback/20260804185311_sam80_shared_operational_services_rollback.sql",
      "supabase/rollback/20260804193000_sam20_synthetic_support_cleanup_boundary_rollback.sql",
      "supabase/rollback/20260805000000_sam78_product_saas_synthetic_cleanup_boundary_rollback.sql",
      "supabase/rollback/20260805010000_sam78_v4_exit_digest_contract_rollback.sql",
      "supabase/rollback/20260806060000_sam78_product_saas_closed_cleanup_boundary_rollback.sql",
      "supabase/rollback/20260806070000_sam78_product_saas_inactive_audit_cleanup_boundary_rollback.sql",
      "supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql",
      "supabase/rollback/20260805190000_v4_commercial_control_plane_rollback.sql",
      "scripts/uat/sam78-staging-migration-verify.sql",
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
      "tests/database/v4-tenant-lifecycle-closure.sql",
      "tests/database/v4-tenant-workflow-concurrency-prelude.sql",
      "tests/database/v4-tenant-workflow-fault-injection.sql",
      "tests/database/v4-tenant-workflow-concurrency-cleanup.sql",
      "tests/database/v4-tenant-lifecycle-closure-prelude.sql",
      "tests/database/v4-platform-staff-role-mapping-prelude.sql",
      "tests/database/v4-tenant-lifecycle-rollback-verify.sql",
      "tests/database/v4-commercial-control-plane.sql",
      "tests/database/v4-commercial-control-plane-rollback-verify.sql",
      "tests/database/sam20-synthetic-support-cleanup-boundary.sql",
      "tests/database/sam80-shared-operational-services.sql",
      "tests/database/sam80-shared-operational-services-rollback-verify.sql",
      "tests/database/sam78-product-saas-synthetic-cleanup-boundary.sql",
      "tests/database/sam78-product-saas-closed-cleanup-boundary.sql",
      "tests/database/sam78-product-saas-inactive-audit-cleanup-boundary.sql",
      "tests/database/sam78-product-saas-synthetic-cleanup-rollback-verify.sql",
    ]) {
      await copyFixture(container, relativePath);
    }

    requireSuccess(
      psql(container, ["-f", "sam23-organization-commercial-core.sql"]),
      "sam23_apply_harness",
    );

    // Exercise the exact legacy caller-supplied actor RPCs that SAM-78 keeps
    // service-only across both its forward migration and rollback.
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260612000001_rpc_functions.sql",
      ]),
      "legacy_payment_actor_rpcs_apply",
    );

    // The reduced SAM-23 harness creates the SAM-20 support tables but skips
    // the canonical SAM-14 atomic support-session RPC migration.
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260730225759_sam14_platform_support_session_lifecycle.sql",
      ]),
      "sam14_support_session_lifecycle_apply",
    );
    const supportSignature = requireSuccess(
      psql(container, [
        "-A",
        "-t",
        "-q",
        "-c",
        "SELECT to_regprocedure('public.start_support_session_atomic(uuid,uuid,uuid,text,text,jsonb,timestamptz,text)') IS NOT NULL",
      ]),
      "sam14_support_session_signature_probe",
    );
    if (supportSignature.stdout.trim() !== "t") {
      throw new Error("sam14_support_session_signature_missing");
    }

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
      verifySam78Live(container, "apply", "pre"),
      "v4_tenant_live_verify_apply_pre",
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
      psql(container, ["-f", "v4-tenant-lifecycle-closure-prelude.sql"]),
      "v4_tenant_lifecycle_closure_prelude",
    );
    requireSuccess(
      psql(container, ["-f", "v4-platform-staff-role-mapping-prelude.sql"]),
      "v4_platform_staff_role_mapping_prelude",
    );
    const deniedUnmappedPlatformStaff = psql(container, [
      "-f",
      "/work/supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql",
    ]);
    if (
      deniedUnmappedPlatformStaff.status === 0
      || !combined(deniedUnmappedPlatformStaff).includes(
        "platform_staff_role_mapping_required:78000000-0099-4000-8000-000000000099",
      )
    ) {
      throw new Error("v4_platform_staff_role_mapping_not_fail_closed");
    }
    const failedMappingApplyWasAtomic = requireSuccess(
      psql(container, [
        "-A", "-t", "-q", "-c",
        "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'platform_staff' AND column_name = 'role_key')",
      ]),
      "v4_platform_staff_role_mapping_failed_apply_atomicity",
    );
    if (failedMappingApplyWasAtomic.stdout.trim() !== "t") {
      throw new Error("v4_platform_staff_role_mapping_failed_apply_changed_schema");
    }
    requireSuccess(
      psql(container, [
        "-c",
        `INSERT INTO public.contracts (
          id, organization_id, lead_id, contract_no, contract_date,
          contract_amount, party_a_name, party_b_name, status
        ) VALUES (
          '78000000-2091-4000-8000-000000000091',
          '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
          '78000000-1090-4000-8000-000000000090',
          'LEGACY-NONSTANDARD-008', DATE '2026-08-02', 800,
          'Invalid legacy sequence', 'NewMe', 'archived'
        )`,
      ]),
      "v4_invalid_legacy_contract_seed",
    );
    const deniedInvalidLegacyContract = psql(container, [
      "-c",
      "SET newme.platform_staff_role_mapping = '{\"78000000-0099-4000-8000-000000000099\":\"platform_support\"}'",
      "-f",
      "/work/supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql",
    ]);
    if (
      deniedInvalidLegacyContract.status === 0
      || !combined(deniedInvalidLegacyContract).includes(
        "legacy_contract_number_invalid:78000000-2091-4000-8000-000000000091",
      )
    ) {
      throw new Error("v4_invalid_legacy_contract_not_fail_closed");
    }
    requireSuccess(
      psql(container, [
        "-c",
        "DELETE FROM public.contracts WHERE id = '78000000-2091-4000-8000-000000000091'",
      ]),
      "v4_invalid_legacy_contract_cleanup",
    );
    requireSuccess(
      psql(container, [
        "-c",
        "SET newme.platform_staff_role_mapping = '{\"78000000-0099-4000-8000-000000000099\":\"platform_support\"}'",
        "-f",
        "/work/supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql",
      ]),
      "v4_tenant_lifecycle_closure_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260804165734_sam26_synthetic_audit_cleanup_boundary.sql",
      ]),
      "sam26_synthetic_audit_cleanup_boundary_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260804185311_sam80_shared_operational_services.sql",
      ]),
      "sam80_shared_operational_services_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260804193000_sam20_synthetic_support_cleanup_boundary.sql",
      ]),
      "sam20_synthetic_support_cleanup_boundary_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260805000000_sam78_product_saas_synthetic_cleanup_boundary.sql",
      ]),
      "sam78_product_saas_synthetic_cleanup_boundary_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260805010000_sam78_v4_exit_digest_contract.sql",
      ]),
      "sam78_v4_exit_digest_contract_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260806060000_sam78_product_saas_closed_cleanup_boundary.sql",
      ]),
      "sam78_product_saas_closed_cleanup_boundary_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260806070000_sam78_product_saas_inactive_audit_cleanup_boundary.sql",
      ]),
      "sam78_product_saas_inactive_audit_cleanup_boundary_apply",
    );
    requireSuccess(
      psql(container, [
        "-f",
        "/work/supabase/migrations/20260805020000_sam81_real_estate_listing_foundation.sql",
      ]),
      "sam81_real_estate_listing_foundation_apply",
    );
    if (SAM78_GATE_PHASE === "apply" || SAM78_GATE_PHASE === "rollback") {
      requireSuccess(
        psql(container, [
          "-f",
          "/work/supabase/migrations/20260805190000_v4_commercial_control_plane.sql",
        ]),
        "v4_commercial_control_plane_apply",
      );
    }
    requireSuccess(
      verifySam78Live(container, "apply", "post"),
      "v4_tenant_live_verify_apply_post",
    );
    if (SAM78_GATE_PHASE === "apply") {
      process.stdout.write(`${JSON.stringify({
        status: "passed",
        phase: "apply",
        environment: "disposable_test_container",
      })}\n`);
      return;
    }
    if (SAM78_GATE_PHASE !== "rollback") {
      requireSuccess(
        psql(container, ["-f", "v4-tenant-lifecycle-closure.sql"]),
        "v4_tenant_lifecycle_closure_fixture",
      );
      requireSuccess(
        psql(container, ["-f", "sam20-synthetic-support-cleanup-boundary.sql"]),
        "sam20_synthetic_support_cleanup_boundary_fixture",
      );
      requireSuccess(
        psql(container, ["-f", "sam80-shared-operational-services.sql"]),
        "sam80_shared_operational_services_fixture",
      );
      requireSuccess(
        psql(container, ["-f", "sam78-product-saas-synthetic-cleanup-boundary.sql"]),
        "sam78_product_saas_synthetic_cleanup_boundary_fixture",
      );
      requireSuccess(
        psql(container, ["-f", "sam78-product-saas-closed-cleanup-boundary.sql"]),
        "sam78_product_saas_closed_cleanup_boundary_fixture",
      );
      requireSuccess(
        psql(container, ["-f", "sam78-product-saas-inactive-audit-cleanup-boundary.sql"]),
        "sam78_product_saas_inactive_audit_cleanup_boundary_fixture",
      );
      requireSuccess(
        psql(container, ["-f", "v4-tenant-workflow-concurrency-prelude.sql"]),
        "v4_tenant_workflow_concurrency_prelude",
      );
      const authPrefix = `SET ROLE authenticated;
        SET request.jwt.claim.sub = '78000000-0090-4000-8000-000000000090';
        SET request.headers = '{"x-newme-organization-id":"78000000-9090-4000-8000-000000000090"}';`;
      const createSql = `${authPrefix}
        SELECT public.v4_create_contract_for_organization(
          '78000000-9090-4000-8000-000000000090',
          jsonb_build_object(
            'lead_id', '78000000-9290-4000-8000-000000000090',
            'amount', 100,
            'installments', jsonb_build_array(jsonb_build_object(
              'seq', 1, 'amount', 100, 'due_date', (current_date + 30)::text
            ))
          ),
          'sam78.concurrent.create.0001'
        )`;
      const createResults = await Promise.all([
        psqlAsync(container, createSql),
        psqlAsync(container, createSql),
      ]);
      for (const result of createResults) {
        requireSuccess(result, "v4_concurrent_same_key_create");
      }
      const convertSql = (key) => `${authPrefix}
        SELECT public.v4_convert_quotation_for_organization(
          '78000000-9090-4000-8000-000000000090',
          '78000000-9390-4000-8000-000000000090',
          jsonb_build_object(
            'installments', jsonb_build_array(jsonb_build_object(
              'seq', 1, 'amount', 200, 'due_date', (current_date + 30)::text
            ))
          ),
          '${key}'
        )`;
      const convertResults = await Promise.all([
        psqlAsync(container, convertSql("sam78.concurrent.quote.0001")),
        psqlAsync(container, convertSql("sam78.concurrent.quote.0002")),
      ]);
      const successfulConversions = convertResults.filter(
        (result) => !result.error && result.status === 0,
      );
      const rejectedConversions = convertResults.filter(
        (result) => result.error || result.status !== 0,
      );
      if (successfulConversions.length !== 1 || rejectedConversions.length !== 1
        || !combined(rejectedConversions[0]).includes("quotation_already_converted")) {
        throw new Error(`v4_concurrent_quote_conversion_contract_failed:${convertResults.map(combined).join("\n")}`);
      }
      const concurrencyEvidence = requireSuccess(
        psql(container, [
          "-A", "-t", "-q", "-c",
          `SELECT json_build_object(
            'contracts', (SELECT count(*) FROM public.contracts WHERE organization_id = '78000000-9090-4000-8000-000000000090'),
            'numbers', (SELECT count(DISTINCT contract_no) FROM public.contracts WHERE organization_id = '78000000-9090-4000-8000-000000000090'),
            'requests', (SELECT count(*) FROM public.contract_workflow_requests WHERE organization_id = '78000000-9090-4000-8000-000000000090'),
            'quote_linked', (SELECT contract_id IS NOT NULL FROM public.quotations WHERE id = '78000000-9390-4000-8000-000000000090'),
            'next_value', (SELECT next_value FROM public.organization_document_sequences WHERE organization_id = '78000000-9090-4000-8000-000000000090' AND document_kind = 'contract' AND document_date = current_date)
          )`,
        ]),
        "v4_tenant_workflow_concurrency_evidence",
      );
      const concurrencyContract = JSON.parse(concurrencyEvidence.stdout.trim());
      if (concurrencyContract.contracts !== 2
        || concurrencyContract.numbers !== 2
        || concurrencyContract.requests !== 2
        || concurrencyContract.quote_linked !== true
        || concurrencyContract.next_value !== 3) {
        throw new Error(`v4_tenant_workflow_concurrency_mismatch:${concurrencyEvidence.stdout.trim()}`);
      }
      requireSuccess(
        psql(container, ["-f", "v4-tenant-workflow-fault-injection.sql"]),
        "v4_tenant_workflow_fault_injection",
      );
      requireSuccess(
        psql(container, ["-f", "v4-tenant-workflow-concurrency-cleanup.sql"]),
        "v4_tenant_workflow_concurrency_cleanup",
      );
      requireSuccess(
        psql(container, [
          "-f",
          "/work/supabase/migrations/20260805190000_v4_commercial_control_plane.sql",
        ]),
        "v4_commercial_control_plane_apply",
      );
      requireSuccess(
        psql(container, ["-f", "v4-commercial-control-plane.sql"]),
        "v4_commercial_control_plane_fixture",
      );
      if (SAM78_GATE_PHASE === "fixture") {
        process.stdout.write(`${JSON.stringify({
          status: "passed",
          phase: "fixture",
          cleanup: "verified",
          environment: "disposable_test_container",
        })}\n`);
        return;
      }
    }
    requireSuccess(
      verifySam78Live(container, "rollback", "pre"),
      "v4_tenant_live_verify_rollback_pre",
    );
    const missingRollbackEnvironment = requireSuccess(
      psql(container, [
        "-A", "-t", "-q", "-c",
        "SELECT current_setting('newme.environment', true) IS NULL",
      ]),
      "v4_tenant_lifecycle_closure_missing_environment_probe",
    );
    if (missingRollbackEnvironment.stdout.trim() !== "t") {
      throw new Error("v4_tenant_lifecycle_closure_missing_environment_probe_failed");
    }
    const deniedSam20SupportRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260804193000_sam20_synthetic_support_cleanup_boundary_rollback.sql",
    ]);
    if (
      deniedSam20SupportRollback.status === 0
      || !combined(deniedSam20SupportRollback).includes(
        "sam20_synthetic_support_cleanup_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("sam20_synthetic_support_cleanup_rollback_not_fail_closed");
    }
    const deniedSam79CommercialRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260805190000_v4_commercial_control_plane_rollback.sql",
    ]);
    if (
      deniedSam79CommercialRollback.status === 0
      || !combined(deniedSam79CommercialRollback).includes(
        "v4_commercial_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("v4_commercial_control_plane_rollback_not_fail_closed");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260805190000_v4_commercial_control_plane_rollback.sql",
        ],
        "test",
      ),
      "v4_commercial_control_plane_rollback",
    );
    requireSuccess(
      psql(container, ["-f", "v4-commercial-control-plane-rollback-verify.sql"]),
      "v4_commercial_control_plane_rollback_verify",
    );
    const deniedSam81Rollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql",
    ]);
    if (
      deniedSam81Rollback.status === 0
      || !combined(deniedSam81Rollback).includes("sam81_rollback_requires_staging_or_test")
    ) {
      throw new Error("sam81_real_estate_listing_foundation_rollback_not_fail_closed");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql",
        ],
        "test",
      ),
      "sam81_real_estate_listing_foundation_rollback",
    );
    const deniedSam78V4ExitDigestRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260805010000_sam78_v4_exit_digest_contract_rollback.sql",
    ]);
    if (
      deniedSam78V4ExitDigestRollback.status === 0
      || !combined(deniedSam78V4ExitDigestRollback).includes(
        "sam78_v4_exit_digest_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("sam78_v4_exit_digest_rollback_not_fail_closed");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260805010000_sam78_v4_exit_digest_contract_rollback.sql",
        ],
        "test",
      ),
      "sam78_v4_exit_digest_contract_rollback",
    );
    const deniedSam78ProductCleanupRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260805000000_sam78_product_saas_synthetic_cleanup_boundary_rollback.sql",
    ]);
    if (
      deniedSam78ProductCleanupRollback.status === 0
      || !combined(deniedSam78ProductCleanupRollback).includes(
        "sam78_product_saas_cleanup_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("sam78_product_saas_cleanup_rollback_not_fail_closed");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260805000000_sam78_product_saas_synthetic_cleanup_boundary_rollback.sql",
        ],
        "test",
      ),
      "sam78_product_saas_synthetic_cleanup_boundary_rollback",
    );
    requireSuccess(
      psql(container, ["-f", "sam78-product-saas-synthetic-cleanup-rollback-verify.sql"]),
      "sam78_product_saas_synthetic_cleanup_boundary_rollback_verify",
    );
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260804193000_sam20_synthetic_support_cleanup_boundary_rollback.sql",
        ],
        "test",
      ),
      "sam20_synthetic_support_cleanup_boundary_rollback",
    );
    const deniedSam80Rollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260804185311_sam80_shared_operational_services_rollback.sql",
    ]);
    if (
      deniedSam80Rollback.status === 0
      || !combined(deniedSam80Rollback).includes(
        "sam80_shared_services_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("sam80_shared_operational_services_rollback_not_fail_closed");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260804185311_sam80_shared_operational_services_rollback.sql",
        ],
        "test",
      ),
      "sam80_shared_operational_services_rollback",
    );
    requireSuccess(
      psql(container, ["-f", "sam80-shared-operational-services-rollback-verify.sql"]),
      "sam80_shared_operational_services_rollback_verify",
    );
    const deniedSam26AuditRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260804165734_sam26_synthetic_audit_cleanup_boundary_rollback.sql",
    ]);
    if (
      deniedSam26AuditRollback.status === 0
      || !combined(deniedSam26AuditRollback).includes(
        "sam26_synthetic_audit_cleanup_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("sam26_synthetic_audit_cleanup_rollback_not_fail_closed");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260804165734_sam26_synthetic_audit_cleanup_boundary_rollback.sql",
        ],
        "test",
      ),
      "sam26_synthetic_audit_cleanup_boundary_rollback",
    );
    const deniedV4ClosureRollback = psql(container, [
      "-f",
      "/work/supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql",
    ]);
    if (
      deniedV4ClosureRollback.status === 0
      || !combined(deniedV4ClosureRollback).includes(
        "v4_tenant_lifecycle_closure_rollback_requires_staging_or_test",
      )
    ) {
      throw new Error("v4_tenant_lifecycle_closure_rollback_not_fail_closed");
    }
    const v4ClosureStillApplied = requireSuccess(
      psql(container, [
        "-A", "-t", "-q", "-c",
        "SELECT to_regclass('public.tenant_file_objects') IS NOT NULL AND to_regprocedure('public.v4_transition_organization_lifecycle(uuid,text,uuid,uuid,text,text)') IS NOT NULL",
      ]),
      "v4_tenant_lifecycle_closure_failed_rollback_atomicity",
    );
    if (v4ClosureStillApplied.stdout.trim() !== "t") {
      throw new Error("v4_tenant_lifecycle_closure_failed_rollback_changed_schema");
    }
    requireSuccess(
      psql(
        container,
        [
          "-f",
          "/work/supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql",
        ],
        "test",
      ),
      "v4_tenant_lifecycle_closure_rollback",
    );
    requireSuccess(
      psql(container, ["-f", "v4-tenant-lifecycle-rollback-verify.sql"]),
      "v4_tenant_lifecycle_closure_rollback_verify",
    );
    if (SAM78_GATE_PHASE === "rollback") {
      process.stdout.write(`${JSON.stringify({
        status: "passed",
        phase: "rollback",
        rollback_fail_closed: "verified",
        cleanup: "verified",
        environment: "disposable_test_container",
      })}\n`);
      return;
    }

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
    requireSuccess(
      verifySam78Live(container, "rollback", "post"),
      "v4_tenant_live_verify_rollback_post",
    );

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
      v4_tenant_lifecycle_closure: "verified",
      sam20_synthetic_support_cleanup: "verified",
      sam78_product_saas_synthetic_cleanup: "verified",
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
