import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-22 migration makes async identities organization-scoped and rollback fail closed", async () => {
  const [migration, rollback, types] = await Promise.all([
    read("supabase/migrations/20260730110000_sam22_two_organization_isolation.sql"),
    read("supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql"),
    read("src/types/database.ts"),
  ]);

  assert.match(
    migration,
    /CREATE UNIQUE INDEX leads_organization_import_fingerprint_unique[\s\S]*organization_id, import_fingerprint/i,
  );
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS organization_id uuid[\s\S]*ALTER COLUMN organization_id SET NOT NULL/i,
  );
  assert.match(
    migration,
    /CREATE POLICY sam22_crm_daily_funnel_snapshot_organization_boundary[\s\S]*AS RESTRICTIVE[\s\S]*requested_organization_id\(\)/i,
  );
  assert.match(
    rollback,
    /sam22_rollback_requires_staging_or_test/,
  );
  assert.match(rollback, /sam22_rollback_snapshot_fixtures_not_clean/);
  assert.match(rollback, /sam22_rollback_import_fixtures_not_clean/);
  assert.match(types, /crm_daily_funnel_snapshot:[\s\S]*organization_id: string/);
  assert.match(
    types,
    /crm_daily_funnel_snapshot_organization_id_fkey/,
  );
});

test("list, search, direct-ID, and export all carry the same explicit organization boundary", async () => {
  const [list, detail, exportRoute] = await Promise.all([
    read("src/app/api/leads/list/route.ts"),
    read("src/app/api/leads/[id]/route.ts"),
    read("src/app/api/leads/export/route.ts"),
  ]);

  assert.match(list, /resolveLeadOrganizationAccess/);
  assert.match(list, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(list, /searchParams\.get\("q"\)/);
  assert.match(list, /customer_name\.ilike/);
  assert.match(detail, /resolveLeadOrganizationAccess/);
  assert.match(detail, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(detail, /\.eq\("id", id\)/);
  assert.match(exportRoute, /support_export_not_permitted/);
  assert.match(exportRoute, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(exportRoute, /text\/csv/);
  assert.match(exportRoute, /formulaSafe/);
});

test("webhook, import, cron, and Dashboard are explicitly organization-scoped", async () => {
  const [webhook, importRoute, importMigration, cron, dashboard] = await Promise.all([
    read("src/app/api/leads/meta-capi/route.ts"),
    read("src/app/api/leads/import/confirm/route.ts"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("src/app/api/cron/daily-funnel-snapshot/route.ts"),
    read("src/app/api/dashboard/summary/route.ts"),
  ]);

  assert.match(webhook, /getRequestedOrganizationId\(request\)/);
  assert.match(webhook, /organization_context_required/);
  assert.match(webhook, /\.eq\("organization_id", organizationId\)/);
  assert.match(webhook, /organization_id: organizationId/);

  assert.match(importRoute, /resolveLeadOrganizationAccess/);
  assert.match(importRoute, /\.rpc\(\s*"v4_import_leads_for_organization"/);
  assert.match(importRoute, /p_organization_id: access\.organizationId/);
  assert.match(importRoute, /p_rows: normalizedRows/);
  assert.doesNotMatch(importRoute, /\.from\(["']leads["']\)[\s\S]*\.upsert\(/);
  assert.match(
    importMigration,
    /ON CONFLICT \(organization_id, import_fingerprint\) DO NOTHING/,
  );
  assert.match(importMigration, /'skipped_duplicates', skipped_count/);

  assert.match(cron, /getRequestedOrganizationId\(req\)/);
  assert.match(cron, /\.eq\('organization_id', organization\.id\)/);
  assert.match(cron, /organization_id: organization\.id/);
  assert.doesNotMatch(
    cron,
    /\.delete\(\)[\s\S]*\.eq\('snapshot_date', snapshotDate\)(?![\s\S]*organization_id)/,
  );

  assert.match(dashboard, /resolveLeadOrganizationAccess/);
  assert.match(
    dashboard,
    /dashboard-summary:\$\{organizationId\}/,
  );
  assert.match(dashboard, /\.eq\("organization_id", organizationId\)/);
  assert.match(dashboard, /\.from\("memberships"\)/);
  assert.match(dashboard, /\.eq\("organization_id", organizationId\)/);
});

test("company administrators can only enumerate and mutate members in their active organization", async () => {
  const [access, users, deleteUser, password, actions] = await Promise.all([
    read("src/lib/organization-member-admin.ts"),
    read("src/app/api/users/route.ts"),
    read("src/app/api/users/[id]/route.ts"),
    read("src/app/api/users/[id]/password/route.ts"),
    read("src/app/actions/team.ts"),
  ]);

  assert.match(access, /organization_admin_required/);
  assert.match(access, /\.eq\("organization_id", organizationId\)/);
  assert.match(access, /\.eq\("user_id", context\.user\.id\)/);
  assert.match(access, /\.eq\("status", "active"\)/);
  assert.match(users, /activeOrganizationMemberIds/);
  assert.match(users, /\.in\("id", memberIds\)/);
  assert.match(users, /organization_id: access\.organizationId/);
  assert.match(deleteUser, /requireOrganizationMembership/);
  assert.match(deleteUser, /\.eq\("organization_id", access\.organizationId\)/);
  assert.doesNotMatch(deleteUser, /ban_duration/);
  assert.match(password, /requireOrganizationMembership/);
  assert.match(actions, /resolveOrganizationMemberAdminAccess/);
  assert.match(actions, /requireOrganizationMembership/);
  assert.doesNotMatch(actions, /ban_duration/);
});

test("SAM-22 UAT is release-locked, synthetic-only, and verifies marker cleanup", async () => {
  const uat = await read("scripts/uat/sam22-two-organization-isolation.mjs");

  assert.match(uat, /EXPECTED_PROJECT_REF = "bfsiibofuzoglziltgyd"/);
  assert.match(uat, /RELEASE_MANIFEST_PATH = "\/runner\/release\/manifest\.json"/);
  assert.match(uat, /manifest\?\.git_sha === releaseSha/);
  assert.match(uat, /@invalid\.test/);
  assert.match(uat, /results\.list_search/);
  assert.match(uat, /results\.direct_id/);
  assert.match(uat, /results\.export/);
  assert.match(uat, /results\.import/);
  assert.match(uat, /results\.webhook/);
  assert.match(uat, /SAM22_WEBHOOK_ROUTE_PATH/);
  assert.match(uat, /webhook_not_disabled_in_staging/);
  assert.match(uat, /webhook_cross_org_create_leaked/);
  assert.match(uat, /webhook_bad_secret_not_rejected/);
  assert.doesNotMatch(uat, /required\("META_CAPI_WEBHOOK_SECRET"\)/);
  assert.match(uat, /results\.cron/);
  assert.match(uat, /results\.dashboard/);
  assert.match(uat, /results\.member_admin/);
  for (const fixture of [
    "organizations",
    "memberships",
    "leads",
    "snapshots",
    "audit_events",
    "child_records",
    "user_session_daily",
    "audit_logs",
    "profiles",
    "auth_fixtures",
  ]) {
    assert.ok(uat.includes(`${fixture}: 0`));
  }
  assert.match(uat, /\.from\("user_session_daily"\)[\s\S]*\.in\("user_id", users\)/);
  assert.match(uat, /\.from\("audit_logs"\)[\s\S]*\.in\("actor_id", users\)/);
  assert.match(uat, /cleanup: "verified"/);
  assert.doesNotMatch(uat, /cleanup: 0/);
});
