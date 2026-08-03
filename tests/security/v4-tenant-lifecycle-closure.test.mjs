import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-78 closure contracts direct tenant ownership and lifecycle evidence", async () => {
  const [migration, rollback, fixture, prelude, gate, types, supportMigration,
    rollbackVerify] = await Promise.all([
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("supabase/rollback/20260803143000_v4_tenant_lifecycle_closure_rollback.sql"),
    read("tests/database/v4-tenant-lifecycle-closure.sql"),
    read("tests/database/v4-tenant-lifecycle-closure-prelude.sql"),
    read("scripts/run-sam23-database-gate.mjs"),
    read("src/types/database.ts"),
    read("supabase/migrations/20260730225759_sam14_platform_support_session_lifecycle.sql"),
    read("tests/database/v4-tenant-lifecycle-rollback-verify.sql"),
  ]);

  for (const table of [
    "membership_roles", "activities", "activity_logs", "ad_spend",
    "audit_logs", "business_events", "chat_messages", "customers",
    "follow_up_logs", "knx_designs", "kpi_targets", "lead_assignment_state",
    "lead_deletion_requests", "lead_files", "lead_milestones",
    "lead_mutation_requests", "lead_workflow_stages", "notifications",
    "quotes", "transfer_history", "user_session_daily",
  ]) {
    assert.match(migration, new RegExp(`['\"]${table}['\"]`));
    const tableBlock = types.slice(types.indexOf(`      ${table}: {`));
    const nextTable = /\n      [a-zA-Z0-9_]+: \{\n/.exec(tableBlock.slice(10));
    const isolatedTable = nextTable
      ? tableBlock.slice(0, nextTable.index + 10)
      : tableBlock;
    assert.match(isolatedTable, /organization_id/);
  }
  assert.match(migration, /ALTER COLUMN organization_id SET NOT NULL/);
  assert.match(migration, /products_organization_sku_key/);
  assert.match(migration, /CREATE POLICY v4_tenant_read_gate/);
  assert.match(migration, /CREATE POLICY v4_tenant_insert_gate/);
  assert.match(migration, /CREATE POLICY v4_tenant_update_gate/);
  assert.match(migration, /CREATE POLICY v4_tenant_delete_gate/);
  assert.match(migration, /organization_id = public\.requested_organization_id\(\)/);
  for (const capability of [
    "organization.data.read", "organization.data.create",
    "organization.data.update", "organization.data.delete",
  ]) assert.match(migration, new RegExp(capability.replaceAll(".", "\\.")));
  assert.match(migration, /ERRCODE = '23514', MESSAGE = 'tenant_organization_id_immutable'/);
  assert.match(migration, /CREATE POLICY v4_leads_insert_gate/);
  assert.match(migration, /'leads\.write', 'write'/);
  assert.match(migration, /CREATE TABLE public\.tenant_file_objects/);
  assert.match(migration, /CREATE TABLE public\.organization_lifecycle_requests/);
  assert.match(migration, /CREATE TABLE public\.platform_action_approvals/);
  assert.match(migration, /role_key IN \([\s\S]*?'platform_owner'[\s\S]*?'platform_auditor'/);
  assert.match(migration, /v4_reject_mutation/);
  assert.match(migration, /v4_transition_organization_lifecycle/);
  assert.match(migration, /v4_expire_support_sessions/);
  assert.match(migration, /v4_import_leads_for_organization/);
  assert.match(migration, /v4_export_organization_customer_data/);
  assert.match(migration, /v4_process_no_answer_worker/);
  assert.match(migration, /v4_register_tenant_file/);
  assert.match(migration, /v4_finalize_tenant_file/);
  assert.match(migration, /v4_request_platform_action_approval/);
  assert.match(migration, /v4_approve_platform_action/);
  assert.match(migration, /v4_execute_approved_platform_action/);
  assert.match(migration, /'support\.session\.start'/);
  assert.doesNotMatch(
    migration,
    /v4_execute_approved_platform_action\([\s\S]{0,300}p_(actor|payload|target)/,
  );
  assert.match(migration, /organization\.members\.manage/);
  assert.match(migration, /organization\.data\.export/);
  assert.match(migration, /actor_platform_staff_id <> approver_platform_staff_id/);
  assert.match(migration, /status = 'revoked', revoked_at = now\(\)/);
  assert.match(rollback, /rollback_requires_staging_or_test/);
  assert.match(
    rollback,
    /COALESCE\(current_setting\('newme\.environment', true\), ''\)[\s\S]*NOT IN \('staging', 'test'\)/,
  );
  assert.match(migration, /rollback_new_records_present/);
  assert.match(rollback, /rollback_duplicate_global_sku/);
  assert.match(rollback, /PERFORM public\.v4_assert_tenant_closure_rollback_safe\(\)/);
  assert.match(rollback, /NO FORCE ROW LEVEL SECURITY/);
  assert.match(rollbackVerify, /relforcerowsecurity/);
  for (const table of [
    "membership_roles", "activities", "activity_logs", "ad_spend",
    "audit_logs", "business_events", "chat_messages", "customers",
    "follow_up_logs", "knx_designs", "kpi_targets", "lead_assignment_state",
    "lead_deletion_requests", "lead_files", "lead_milestones",
    "lead_mutation_requests", "lead_workflow_stages", "notifications",
    "quotes", "transfer_history", "user_session_daily",
  ]) assert.match(fixture, new RegExp(`assert_rollback_table_guard\\('${table}'\\)`));
  assert.match(fixture, /cross-organization direct-id\/search leak/);
  assert.match(fixture, /specialist direct lead insert accepted/);
  assert.match(fixture, /specialist direct lead update accepted/);
  assert.match(fixture, /specialist direct lead delete accepted/);
  assert.match(fixture, /lead organization reassignment accepted/);
  assert.match(fixture, /platform support requested organization action/);
  assert.match(fixture, /platform auditor approved organization action/);
  assert.match(fixture, /authenticated registry insert accepted/);
  assert.match(fixture, /authenticated finalize RPC accepted/);
  assert.match(fixture, /operations sealed contract registration accepted/);
  assert.match(fixture, /sales sealed contract registration accepted/);
  assert.match(fixture, /worker crossed organization boundary/);
  assert.match(
    migration,
    /ORDER BY follow_up\.contact_time DESC,[\s\S]*follow_up\.id DESC/,
  );
  assert.match(fixture, /contact_time = now\(\) - interval '1 hour'/);
  assert.match(fixture, /complete suspended export contract failed/);
  assert.match(fixture, /suspension did not revoke support session/);
  assert.match(fixture, /inactive membership retained tenant reads/);
  assert.match(fixture, /audit event mutation accepted/);
  assert.ok(
    fixture.match(/RESET request\.jwt\.claim\.sub;/g)?.length >= 5,
    "service-role fixture segments must clear inherited end-user JWT context",
  );
  for (const column of [
    "customer_name", "raw_import_data", "import_batch_id",
    "import_fingerprint", "imported_by", "next_followup_date",
    "no_answer_flag",
  ]) assert.match(prelude, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  assert.match(prelude, /leads_organization_import_fingerprint_unique/);
  assert.match(prelude, /ON public\.leads \(organization_id, import_fingerprint\)/);
  assert.match(prelude, /ADD COLUMN IF NOT EXISTS party_b_name/);
  assert.match(prelude, /ADD COLUMN IF NOT EXISTS sales_id/);
  assert.match(prelude, /ADD COLUMN IF NOT EXISTS file_metadata/);
  assert.match(gate, /v4_tenant_lifecycle_closure_apply/);
  assert.match(gate, /v4_tenant_lifecycle_closure_rollback_verify/);
  assert.match(gate, /v4_tenant_lifecycle_closure_missing_environment_probe/);
  assert.match(gate, /current_setting\('newme\.environment', true\) IS NULL/);
  assert.match(gate, /20260730225759_sam14_platform_support_session_lifecycle\.sql/);
  assert.match(gate, /sam14_support_session_lifecycle_apply/);
  assert.match(gate, /sam14_support_session_signature_probe/);
  assert.match(gate, /sam14_support_session_signature_missing/);
  assert.match(
    supportMigration,
    /start_support_session_atomic\(\s*p_actor_user_id uuid,\s*p_approver_user_id uuid,\s*p_organization_id uuid,\s*p_ticket_ref text,\s*p_reason text,\s*p_scope jsonb,\s*p_expires_at timestamptz,\s*p_request_id text\s*\)/,
  );
  assert.match(fixture, /'support\.session\.start'/);
  assert.match(fixture, /support approval request was not idempotent/);
  assert.match(fixture, /inactive support request left approval side effects/);
  assert.match(fixture, /inactive approval changed frozen support state/);
  assert.match(fixture, /inactive execution left support side effects/);
  assert.match(fixture, /inactive consumed replay left support side effects/);
  assert.match(fixture, /two-session support approval did not execute atomically/);
  assert.match(fixture, /storage_pending_actor_quota_exceeded/);
  assert.match(fixture, /storage_pending_organization_quota_exceeded/);
  assert.match(types, /tenant_file_objects: \{/);
  assert.match(types, /organization_lifecycle_requests: \{/);
  assert.match(types, /platform_action_approvals: \{/);
  assert.match(types, /v4_import_leads_for_organization: \{/);
  assert.match(types, /v4_execute_approved_platform_action: \{/);
  assert.match(types, /v4_finalize_tenant_file: \{/);
});

test("browser-reachable routes use bounded tenant RPCs instead of service clients", async () => {
  const [leadImport, upload, confirm, download, worker, exportRoute,
    organizations, approvals, organizationExit, supportSessions] = await Promise.all([
    read("src/app/api/leads/import/confirm/route.ts"),
    read("src/app/api/contracts/[id]/upload-url/route.ts"),
    read("src/app/api/contracts/[id]/confirm-upload/route.ts"),
    read("src/app/api/cos/download-url/route.ts"),
    read("src/app/api/cron/check-no-answer/route.ts"),
    read("src/app/api/organizations/export/route.ts"),
    read("src/app/api/platform/organizations/route.ts"),
    read("src/app/api/platform/approvals/route.ts"),
    read("src/app/api/platform/organization-exit/route.ts"),
    read("src/app/api/platform/support-sessions/route.ts"),
  ]);

  assert.match(leadImport, /v4_import_leads_for_organization/);
  assert.doesNotMatch(leadImport, /SUPABASE_SERVICE_ROLE_KEY|createClient\(/);
  assert.match(upload, /storage\.files\.write/);
  assert.match(upload, /v4_register_tenant_file/);
  assert.match(upload, /p_organization_id: access\.organizationId/);
  assert.match(upload, /registration\.key/);
  assert.match(confirm, /v4_finalize_tenant_file/);
  assert.match(confirm, /"--head"/);
  assert.match(confirm, /Object\.keys\(body\)\.length !== 1/);
  assert.match(download, /storage\.files\.read/);
  assert.match(download, /tenant_file_objects/);
  assert.doesNotMatch(download, /resolveLeadIdFromKey/);
  assert.match(worker, /\.eq\("status", "active"\)/);
  assert.match(worker, /v4_process_no_answer_worker/);
  assert.doesNotMatch(worker, /\.from\("leads"\)/);
  assert.match(exportRoute, /organization\.data\.export/);
  assert.match(exportRoute, /v4_export_organization_customer_data/);
  assert.doesNotMatch(organizations, /p_approver_user_id|approverUserId/);
  assert.match(organizations, /v4_request_platform_action_approval/);
  assert.doesNotMatch(organizationExit, /p_approver_user_id|approverUserId/);
  assert.match(organizationExit, /v4_request_platform_action_approval/);
  assert.match(approvals, /v4_approve_platform_action/);
  assert.match(approvals, /v4_execute_approved_platform_action/);
  assert.doesNotMatch(approvals, /p_(actor_user_id|payload|target_key)/);
  assert.match(supportSessions, /parseSupportSessionApprovalRequest/);
  assert.match(supportSessions, /v4_request_platform_action_approval/);
  assert.match(supportSessions, /support\.session\.start/);
  assert.doesNotMatch(supportSessions, /p_approver_user_id/);
});

test("browser quotation writes use the selected organization context without a new Lead scope read", async () => {
  const files = await Promise.all([
    read("src/app/(dashboard)/quotes/quote-calculator.tsx"),
    read("src/app/(dashboard)/quotes/quote-wizard.tsx"),
    read("src/app/(dashboard)/quotes/quotes-client.tsx"),
  ]);

  for (const source of files) {
    assert.match(source, /getBrowserOrganizationId\(\)/);
    assert.match(source, /organization_id: organizationId/);
    assert.doesNotMatch(source, /\.select\("organization_id"\)/);
    assert.doesNotMatch(source, /select\("id, organization_id, customer_name, phone"\)/);
  }
});
