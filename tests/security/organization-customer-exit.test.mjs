import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260801202728_organization_customer_exit_lifecycle.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollback = await readFile(
  new URL(
    "../../supabase/rollback/20260801202728_organization_customer_exit_lifecycle_rollback.sql",
    import.meta.url,
  ),
  "utf8",
);
const notificationUuidFix = await readFile(
  new URL(
    "../../supabase/migrations/20260802074500_fix_customer_export_notification_uuid.sql",
    import.meta.url,
  ),
  "utf8",
);
const notificationUuidRollback = await readFile(
  new URL(
    "../../supabase/rollback/20260802074500_fix_customer_export_notification_uuid_rollback.sql",
    import.meta.url,
  ),
  "utf8",
);
const exportRoute = await readFile(
  new URL("../../src/app/api/organizations/export/route.ts", import.meta.url),
  "utf8",
);
const exitRoute = await readFile(
  new URL("../../src/app/api/platform/organization-exit/route.ts", import.meta.url),
  "utf8",
);

test("customer exit is non-destructive, independently approved and audited", () => {
  assert.match(migration, /status IN \('prepared', 'completed', 'cancelled'\)/);
  assert.match(migration, /requested_by_platform_staff_id <> approved_by_platform_staff_id/);
  assert.match(migration, /UPDATE public\.memberships[\s\S]*status = 'inactive'/);
  assert.match(migration, /UPDATE public\.support_sessions[\s\S]*status = 'revoked'/);
  assert.match(migration, /UPDATE public\.organizations[\s\S]*status = 'closed'/);
  assert.match(migration, /'data_deleted', false/);
  assert.match(migration, /'idempotent', true/);
  assert.doesNotMatch(migration, /DELETE FROM public\./i);
});

test("customer export is deterministic, complete by catalog and service-role only", () => {
  for (const table of [
    "organizations", "memberships", "membership_roles", "profiles",
    "audit_events", "support_sessions", "leads", "activities",
    "customers", "lead_files", "quotations", "contracts", "payments",
    "projects", "tasks", "products", "activity_logs", "user_session_daily",
  ]) {
    assert.match(migration, new RegExp(`'${table}'`));
  }
  assert.match(migration, /jsonb_agg\(to_jsonb\(export_row\) ORDER BY/);
  assert.match(migration, /extensions\.digest\(convert_to\(snapshot::text, 'UTF8'\), 'sha256'\)/);
  assert.match(migration, /legacy_unscoped_tables/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated;[\s\S]*TO service_role;/);
});

test("customer export compares canonical uuid notification references without casts", () => {
  assert.match(notificationUuidFix, /old_token_count <> 6/);
  assert.match(notificationUuidFix, /new_token_count <> 6/);
  assert.match(notificationUuidFix, /security_metadata_drift/);
  assert.match(notificationUuidFix, /replace\(function_sql, old_token, new_token\)/);
  assert.doesNotMatch(notificationUuidFix, /DELETE FROM public\./i);
  assert.match(
    notificationUuidRollback,
    /customer_export_notification_uuid_rollback_requires_staging_or_test/,
  );
});

test("read-only lifecycle is enforced below application routes", () => {
  assert.match(migration, /CREATE TRIGGER zz_organization_lifecycle_write_guard/);
  assert.match(migration, /status = 'active'/);
  assert.match(migration, /organization_is_not_writable/);
  assert.match(migration, /'quotations', 'contracts'/);
  assert.match(migration, /'products', 'activity_logs'/);
});

test("customer and platform APIs preserve separate authorization boundaries", () => {
  assert.match(exportRoute, /resolveOrganizationMemberAdminAccess\(request\)/);
  assert.match(exportRoute, /export_organization_customer_data/);
  assert.match(exportRoute, /Content-Disposition/);
  assert.match(exportRoute, /Cache-Control": "no-store"/);
  assert.match(exitRoute, /getRequestAuthContext\(request\)/);
  assert.match(exitRoute, /prepare_organization_customer_exit/);
  assert.match(exitRoute, /complete_organization_customer_exit/);
  assert.doesNotMatch(exitRoute, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("rollback is staging/test only and refuses completed exits", () => {
  assert.match(rollback, /organization_exit_rollback_requires_staging_or_test/);
  assert.match(rollback, /COALESCE\(current_setting\('newme\.environment', true\), ''\)/);
  assert.match(rollback, /completed_organization_exit_blocks_schema_rollback/);
  assert.match(rollback, /previous_organization_status/);
  assert.match(rollback, /DROP TABLE public\.organization_exit_requests/);
});
