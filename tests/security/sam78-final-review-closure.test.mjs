import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-78 KPI replacement is tenant-scoped and transactional", async () => {
  const [route, migration, fixture] = await Promise.all([
    read("src/app/api/kpi/targets/route.ts"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("tests/database/v4-tenant-lifecycle-closure.sql"),
  ]);
  assert.match(route, /resolveOrganizationAuthorization\([\s\S]*?"kpi\.targets\.manage"/);
  assert.match(route, /v4_replace_kpi_targets/);
  assert.match(route, /p_organization_id: access\.organizationId/);
  assert.doesNotMatch(route, /supabaseAdmin|\.delete\(\)[\s\S]*?\.insert\(/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.v4_replace_kpi_targets/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /DELETE FROM public\.kpi_targets[\s\S]*?organization_id = p_organization_id/);
  assert.match(
    migration,
    /kpi_targets_organization_period_target_assignee_key[\s\S]*?UNIQUE NULLS NOT DISTINCT\s*\(\s*organization_id, period, target_type, assigned_to\s*\)/,
  );
  assert.match(fixture, /KPI replacement accepted duplicate team-wide target/);
  assert.match(fixture, /failed NULL-assignee KPI replacement deleted organization A baseline/);
  assert.match(fixture, /organization A KPI replacement changed organization B/);
});

test("SAM-78 commercial authorization uses selected organization memberships", async () => {
  const paths = [
    "src/app/actions/payments.ts",
    "src/app/api/payments/route.ts",
    "src/app/api/payments/list/route.ts",
    "src/app/api/payments/[id]/confirm/route.ts",
    "src/app/api/payments/[id]/allocate/route.ts",
    "src/app/api/contracts/route.ts",
    "src/app/api/quotations/[id]/convert/route.ts",
  ];
  const sources = await Promise.all(paths.map(read));
  for (const [index, source] of sources.entries()) {
    assert.match(source, /resolveOrganizationAuthorization/,
      `${paths[index]} must resolve current organization authorization`);
    assert.doesNotMatch(source, /\.from\(["']profiles["']\)[\s\S]{0,120}\.select\(["']role/,
      `${paths[index]} must not authorize from profiles.role`);
  }
  const joined = sources.join("\n");
  for (const capability of [
    "payments.read", "payments.create", "payments.confirm", "payments.allocate",
    "contracts.read", "contracts.create", "contracts.update", "quotations.convert",
  ]) assert.match(joined, new RegExp(capability.replaceAll(".", "\\.")));
  assert.match(joined, /v4_confirm_payment_for_organization/);
  assert.match(joined, /v4_allocate_payment_for_organization/);
  assert.match(joined, /\.eq\(["']organization_id["'], access\.organizationId\)/);

  const fixture = await read("tests/database/v4-tenant-lifecycle-closure.sql");
  assert.match(fixture, /global or organization A authority leaked into B capabilities/);
  assert.match(fixture, /B sales role confirmed payment through global admin role/);
  assert.match(fixture, /B sales role updated another sales contract through global admin role/);
});

test("SAM-78 service notification writers carry explicit organization ownership", async () => {
  const [helper, overdue, reminder, fixture] = await Promise.all([
    read("src/lib/notifications.ts"),
    read("src/app/api/cron/check-overdue-installments/route.ts"),
    read("src/app/api/cron/daily-reminder/route.ts"),
    read("tests/database/v4-tenant-lifecycle-closure.sql"),
  ]);
  assert.match(helper, /organizationId: string/);
  assert.match(helper, /organization_id: organizationId/);
  assert.match(helper, /\.from\("membership_roles"\)/);
  assert.match(helper, /\.eq\("organization_id", organizationId\)/);
  assert.doesNotMatch(helper, /\.from\("profiles"\)[\s\S]{0,160}\.in\("role"/);
  assert.match(overdue, /organization_id: plan\.organization_id/);
  assert.match(overdue, /getAdminUserIds\(plan\.organization_id\)/);
  assert.match(reminder, /organizationId: task\.organization_id/);
  assert.match(reminder, /deliverDailyReminderNotifications/);
  assert.match(reminder, /\.upsert\(notification/);
  assert.match(reminder, /onConflict: "organization_id,user_id,event_key"/);
  assert.match(reminder, /ignoreDuplicates: true/);
  assert.match(fixture, /service notification writer lost organization ownership/);
});

test("SAM-78 pending uploads expire, cancel, compensate, and clean up in bounded batches", async () => {
  const [migration, upload, confirm, worker, fixture, rollback] = await Promise.all([
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("src/app/api/contracts/[id]/upload-url/route.ts"),
    read("src/app/api/contracts/[id]/confirm-upload/route.ts"),
    read("src/app/api/cron/cleanup-pending-uploads/route.ts"),
    read("tests/database/v4-tenant-lifecycle-closure.sql"),
    read("supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql"),
  ]);
  for (const token of [
    "pending_expires_at", "v4_cancel_tenant_file_upload",
    "v4_expire_tenant_file_uploads", "pending_upload_ttl_elapsed",
    "tenant_file_deletion_outbox", "deletion_pending",
    "v4_claim_tenant_file_deletions", "v4_complete_tenant_file_deletion",
    "v4_retry_tenant_file_deletion", "FOR UPDATE SKIP LOCKED",
  ]) assert.match(migration, new RegExp(token));
  assert.match(migration, /p_limit > 10/);
  assert.match(migration, /p_lease_seconds < 60 OR p_lease_seconds > 300/);
  assert.match(migration, /provider_delete_not_before/);
  assert.match(migration, /upload_url_expires_at \+ interval '2 minutes'/);
  assert.match(migration, /cos_delete_failed[\s\S]*?provider_absence_missing[\s\S]*?database_complete_failed[\s\S]*?worker_interrupted/);
  assert.match(upload, /compensateRegistration/);
  assert.match(upload, /cos_presign_execution_failed/);
  assert.match(upload, /upload_url_expiring_new_idempotency_key_required/);
  assert.match(upload, /Math\.min\(900, remainingSeconds\)/);
  assert.match(upload, /request_id: idempotencyKey|p_request_id: idempotencyKey/);
  assert.match(confirm, /compensateFailedConfirmation/);
  assert.match(worker, /DELETION_BATCH_LIMIT = 10/);
  assert.match(worker, /DELETION_CONCURRENCY = 3/);
  assert.match(worker, /DELETION_LEASE_SECONDS = 120/);
  assert.match(worker, /--delete/);
  assert.match(worker, /v4_complete_tenant_file_deletion/);
  assert.match(worker, /v4_retry_tenant_file_deletion/);
  assert.match(fixture, /expired upload released quota before provider deletion/);
  assert.match(fixture, /cross-organization deletion completion accepted/);
  assert.match(fixture, /bounded deletion claims overlapped or exceeded ten/);
  assert.match(fixture, /expired deletion lease was not safely recovered/);
  for (const name of [
    "v4_cancel_tenant_file_upload", "v4_expire_tenant_file_uploads",
    "v4_claim_tenant_file_deletions", "v4_complete_tenant_file_deletion",
    "v4_retry_tenant_file_deletion",
  ]) assert.match(rollback, new RegExp(`DROP FUNCTION IF EXISTS public\\.${name}`));
  assert.match(rollback, /DROP TABLE public\.tenant_file_deletion_outbox;[\s\S]*?DROP TABLE public\.tenant_file_objects;/);
});

test("SAM-78 browser notification bridge is creation-only and replay-safe", async () => {
  const [route, helper, migration] = await Promise.all([
    read("src/app/api/notify/route.ts"),
    read("src/lib/notifications.ts"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
  ]);
  assert.match(route, /type BrowserEvent = "lead_created" \| "quote_created"/);
  assert.match(route, /created_by !== user\.id/);
  assert.match(route, /lead:\$\{lead\.id\}:created/);
  assert.match(route, /quotation:\$\{quotation\.id\}:created/);
  assert.match(route, /system_notification_event_forbidden/);
  assert.doesNotMatch(route, /untrustedBody\.(?:recipient|user_id|title|body)/);
  assert.match(helper, /event_key: n\.eventKey/);
  assert.match(helper, /ignoreDuplicates: true/);
  assert.match(migration, /notifications_organization_user_event_key_unique/);
  assert.match(migration, /ON CONFLICT \(organization_id, user_id, event_key\) DO NOTHING/);
});

test("SAM-78 contract workflows are one-call atomic and explicitly idempotent", async () => {
  const [createRoute, convertRoute, migration, gate, faults] = await Promise.all([
    read("src/app/api/contracts/route.ts"),
    read("src/app/api/quotations/[id]/convert/route.ts"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("scripts/run-sam23-database-gate.mjs"),
    read("tests/database/v4-tenant-workflow-fault-injection.sql"),
  ]);
  for (const route of [createRoute, convertRoute]) {
    assert.match(route, /headers\.get\("idempotency-key"\)/);
    assert.match(route, /invalid_idempotency_key/);
    assert.match(route, /request\.json\(\)\.catch\(\(\) => null\)/);
  }
  assert.match(createRoute, /v4_create_contract_for_organization/);
  assert.match(convertRoute, /v4_convert_quotation_for_organization/);
  assert.match(migration, /CREATE TABLE public\.organization_document_sequences/);
  assert.match(migration, /CREATE TABLE public\.contract_workflow_requests/);
  assert.match(migration, /legacy_contract_number_invalid/);
  assert.match(migration, /contract_document_sequence_exhausted/);
  assert.match(migration, /contract_installments_total_mismatch/);
  assert.match(gate, /v4-tenant-workflow-concurrency-prelude\.sql/);
  assert.match(gate, /v4-tenant-workflow-fault-injection\.sql/);
  assert.match(gate, /quotation_already_converted/);
  for (const trigger of ["contracts", "installments", "approvals", "quotations", "leads", "projects", "activities"]) {
    assert.match(faults, new RegExp(`sam78_fail_${trigger}`));
  }
});

test("SAM-78 rollback removes additive workflow objects and restores exact legacy policies", async () => {
  const [migration, rollback, verify] = await Promise.all([
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql"),
    read("tests/database/v4-tenant-lifecycle-rollback-verify.sql"),
  ]);
  assert.match(migration, /CREATE TABLE public\.v4_legacy_policy_snapshots/);
  assert.match(migration, /LOCK TABLE public\.notifications IN ACCESS EXCLUSIVE MODE/);
  assert.match(migration, /CREATE TABLE public\.v4_legacy_table_acl_snapshots/);
  assert.match(migration, /pg_catalog\.aclexplode/);
  assert.match(rollback, /SELECT \* FROM public\.v4_legacy_policy_snapshots/);
  assert.match(rollback, /v4_notifications_acl_restore_mismatch/);
  assert.match(rollback, /GRANT %s ON TABLE public\.notifications TO %s%s/);
  assert.match(rollback, /CREATE POLICY %I ON %I\.%I AS %s FOR %s TO %s%s%s/);
  assert.match(rollback, /legacy_policy_restore_mismatch/);
  assert.match(verify, /has_table_privilege[\s\S]*?'authenticated', 'public\.notifications', 'INSERT'/);
  assert.match(verify, /rollback authenticated notification insert failed/);
  for (const object of [
    "tenant_file_deletion_outbox", "contract_workflow_requests",
    "organization_document_sequences", "tenant_file_objects",
  ]) assert.match(verify, new RegExp(object));
  for (const fn of [
    "v4_claim_tenant_file_deletions", "v4_complete_tenant_file_deletion",
    "v4_retry_tenant_file_deletion", "v4_create_contract_for_organization",
    "v4_convert_quotation_for_organization",
  ]) assert.match(verify, new RegExp(fn));
});

test("SAM-78 platform authority mapping and FORCE RLS fail closed dynamically", async () => {
  const [migration, gate, fixture, rollback, rollbackVerify] = await Promise.all([
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("scripts/run-sam23-database-gate.mjs"),
    read("tests/database/v4-tenant-lifecycle-closure.sql"),
    read("supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql"),
    read("tests/database/v4-tenant-lifecycle-rollback-verify.sql"),
  ]);
  assert.match(migration, /newme\.platform_staff_role_mapping/);
  assert.match(migration, /platform_staff_role_mapping_required/);
  assert.doesNotMatch(migration, /SET role_key = CASE profile\.role/);
  assert.doesNotMatch(migration, /SET role_key = 'platform_support'\s+WHERE role_key IS NULL/);
  assert.match(gate, /v4_platform_staff_role_mapping_not_fail_closed/);
  assert.match(gate, /v4_platform_staff_role_mapping_failed_apply_atomicity/);
  assert.match(migration, /ALTER TABLE public\.leads FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE public\.organization_lifecycle_requests FORCE ROW LEVEL SECURITY/);
  assert.match(fixture, /pg_class relation/);
  assert.match(fixture, /relation\.relforcerowsecurity IS DISTINCT FROM true/);
  assert.match(rollback, /ALTER TABLE public\.leads NO FORCE ROW LEVEL SECURITY/);
  assert.match(rollbackVerify, /'leads'/);
});

test("SAM-78 rollback keeps caller-supplied payment actor RPCs service-only", async () => {
  const [gate, rollback, rollbackVerify] = await Promise.all([
    read("scripts/run-sam23-database-gate.mjs"),
    read("supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql"),
    read("tests/database/v4-tenant-lifecycle-rollback-verify.sql"),
  ]);
  assert.match(gate, /20260612000001_rpc_functions\.sql/);
  assert.match(gate, /legacy_payment_actor_rpcs_apply/);
  for (const signature of [
    "confirm_payment\\(uuid, uuid\\)",
    "allocate_payment\\(uuid, jsonb, uuid\\)",
  ]) {
    assert.match(
      rollback,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature}\\s+FROM PUBLIC, anon, authenticated`),
    );
    assert.match(
      rollback,
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature}\\s+TO service_role`),
    );
    assert.doesNotMatch(
      rollback,
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature}\\s+TO PUBLIC`),
    );
  }
  assert.match(rollbackVerify, /has_function_privilege\('anon', function_oid, 'EXECUTE'\)/);
  assert.match(rollbackVerify, /has_function_privilege\('authenticated', function_oid, 'EXECUTE'\)/);
  assert.match(rollbackVerify, /has_function_privilege\('service_role', function_oid, 'EXECUTE'\)/);
  assert.match(rollbackVerify, /SET ROLE anon;[\s\S]*?PERFORM public\.confirm_payment/);
  assert.match(rollbackVerify, /SET ROLE authenticated;[\s\S]*?PERFORM public\.allocate_payment/);
  assert.match(rollbackVerify, /SET ROLE service_role;[\s\S]*?Payment not found/);
});
