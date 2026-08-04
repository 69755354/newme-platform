import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const typesPath = resolve(root, "src/types/database.ts");
const migrationsPath = resolve(root, "supabase/migrations");
const provenancePrefix = "// Migration fingerprint: sha256=";
const required = [
  "export type Database =",
  "audit_events:",
  "capabilities:",
  "memberships:",
  "membership_roles:",
  "organizations:",
  "organization_exit_requests:",
  "organization_document_sequences:",
  "organization_provisioning_requests:",
  "organization_lifecycle_requests:",
  "platform_action_approval_events:",
  "platform_action_approvals:",
  "platform_staff:",
  "profiles:",
  "role_capabilities:",
  "roles:",
  "shared_approval_requests:",
  "shared_jobs:",
  "shared_notifications:",
  "shared_outbox:",
  "shared_report_snapshots:",
  "shared_timeline_events:",
  "shared_work_items:",
  "leads:",
  "support_sessions:",
  "contract_workflow_requests:",
  "commercial_action_events:",
  "commercial_action_requests:",
  "commercial_entitlements:",
  "commercial_invoice_references:",
  "commercial_plan_versions:",
  "commercial_seat_events:",
  "commercial_state_events:",
  "commercial_usage_events:",
  "organization_subscriptions:",
  "paid_seat_allocations:",
  "tenant_file_deletion_outbox:",
  "tenant_file_objects:",
  "v4_legacy_table_acl_snapshots:",
  "allocate_payment:",
  "confirm_payment:",
  "end_support_session_atomic:",
  'requested_organization_id: { Args: never; Returns: string }',
  "start_support_session_atomic:",
  "organization_billable_seat_count:",
  "initialize_organization:",
  "complete_organization_customer_exit:",
  "export_organization_customer_data:",
  "organization_customer_snapshot:",
  "prepare_organization_customer_exit:",
  "provision_organization_member:",
  "v4_accept_organization_membership:",
  "v4_claim_shared_jobs:",
  "v4_claim_shared_outbox:",
  "v4_complete_shared_job:",
  "v4_complete_shared_outbox:",
  "v4_create_shared_job:",
  "v4_create_shared_work_item:",
  "v4_decide_shared_approval:",
  "v4_mark_shared_notification_read:",
  "v4_requeue_shared_dead_letter:",
  "v4_request_shared_approval:",
  "v4_transition_shared_work_item:",
  "v4_approve_platform_action:",
  "v4_approve_commercial_action:",
  "v4_allocate_payment_for_organization:",
  "v4_cancel_tenant_file_upload:",
  "v4_claim_tenant_file_deletions:",
  "v4_complete_tenant_file_deletion:",
  "v4_confirm_payment_for_organization:",
  "v4_convert_quotation_for_organization:",
  "v4_create_contract_for_organization:",
  "v4_execute_approved_platform_action:",
  "v4_execute_commercial_action:",
  "v4_expire_tenant_file_uploads:",
  "v4_expire_support_sessions:",
  "v4_export_organization_customer_data:",
  "v4_import_leads_for_organization:",
  "v4_get_commercial_summary:",
  "v4_invite_organization_member:",
  "v4_process_no_answer_worker:",
  "v4_provision_organization:",
  "v4_register_tenant_file:",
  "v4_replace_kpi_targets:",
  "v4_request_platform_action_approval:",
  "v4_request_commercial_action:",
  "v4_record_commercial_usage:",
  "v4_reconcile_commercial_control_plane:",
  "v4_retry_tenant_file_deletion:",
  "v4_finalize_tenant_file:",
  "v4_transition_organization_lifecycle:",
  "v_sam23_organization_commercial_summary:",
  "v4_shared_operations_summary:",
  "transition_lead_stage:",
];

const migrationNames = (await readdir(migrationsPath))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const fingerprintHash = createHash("sha256");
for (const name of migrationNames) {
  const path = resolve(migrationsPath, name);
  fingerprintHash.update(relative(root, path).replaceAll("\\", "/"));
  fingerprintHash.update("\0");
  fingerprintHash.update((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
  fingerprintHash.update("\0");
}
const fingerprint = fingerprintHash.digest("hex");
const provenance = `${provenancePrefix}${fingerprint}`;

const source = await readFile(typesPath, "utf8");
if (process.argv.includes("--stamp")) {
  const stamped = source.startsWith(provenancePrefix)
    ? source.replace(/^\/\/ Migration fingerprint: sha256=[a-f0-9]+\r?\n/, `${provenance}\n`)
    : `${provenance}\n${source}`;
  await writeFile(typesPath, stamped);
} else if (source.split(/\r?\n/, 1)[0] !== provenance) {
  console.error(`Database type source migration fingerprint mismatch: expected ${fingerprint}`);
  process.exit(1);
}

const checkedSource = process.argv.includes("--stamp") ? await readFile(typesPath, "utf8") : source;
const missing = required.filter((token) => !checkedSource.includes(token));
if (missing.length) {
  console.error(`Database type source is incomplete: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("Database type source gate passed");
