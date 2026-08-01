import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("commercial plan seats align to 3, 10, 25 and support one-seat add-ons", async () => {
  const [migration, rollback, types, typeGate] = await Promise.all([
    read("supabase/migrations/20260801120000_commercial_p0_seat_role_integrity.sql"),
    read("supabase/rollback/20260801120000_commercial_p0_seat_role_integrity_rollback.sql"),
    read("src/types/database.ts"),
    read("scripts/check-database-types.mjs"),
  ]);

  assert.match(migration, /ALTER COLUMN billable_seat_limit SET DEFAULT 3/);
  for (const boundary of [
    /plan_key = 'starter' AND billable_seat_limit >= 3/,
    /plan_key = 'growth' AND billable_seat_limit >= 10/,
    /plan_key = 'scale' AND billable_seat_limit >= 25/,
  ]) {
    assert.match(migration, boundary);
  }
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.initialize_organization/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.provision_organization_member/);
  assert.match(migration, /role\.role_key IN \('org_owner', 'org_admin'\)/);
  assert.match(migration, /organization_membership_role_created/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated;[\s\S]*TO service_role;/);
  assert.match(rollback, /commercial_p0_rollback_requires_staging_or_test/);
  assert.match(
    rollback,
    /current_setting\('newme\.environment', true\) IS NULL[\s\S]*NOT IN \('staging', 'test'\)/,
  );
  assert.match(rollback, /commercial_p0_seat_tier_rollback_incompatible/);
  assert.match(types, /provision_organization_member: \{/);
  assert.match(typeGate, /"provision_organization_member:"/);
});

test("both organization user creation paths use atomic membership-role provisioning", async () => {
  const [users, team] = await Promise.all([
    read("src/app/api/users/route.ts"),
    read("src/app/actions/team.ts"),
  ]);

  for (const source of [users, team]) {
    assert.match(source, /\.rpc\([\s\S]*["']provision_organization_member["']/);
    assert.match(source, /p_organization_id: access\.organizationId/);
    assert.match(source, /p_invited_by_membership_id: access\.callerMembershipId/);
    assert.match(source, /p_request_id: access\.context\.requestId/);
    assert.match(source, /auth\.admin\.deleteUser/);
    assert.doesNotMatch(
      source,
      /\.from\(["']memberships["']\)[\s\S]{0,120}\.insert\(/,
    );
  }
});

test("quotation export is organization-bound and never uses service role", async () => {
  const source = await read("src/app/api/quotations/export/route.ts");
  assert.match(source, /resolveLeadOrganizationAccess/);
  assert.match(source, /support_export_not_permitted/);
  assert.match(source, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(source, /\.eq\("leads\.organization_id", access\.organizationId\)/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(source, /createClient\(/);
});

test("settings cache and data are bound to the active organization", async () => {
  const source = await read("src/app/api/settings/data/route.ts");
  assert.match(source, /resolveLeadOrganizationAccess/);
  assert.match(source, /activeOrganizationMemberIds\(organizationId\)/);
  assert.match(
    source,
    /settings:data:\$\{organizationId\}:\$\{role\}:\$\{userId\}:\$\{period\}/,
  );
  assert.match(source, /\.eq\("organization_id", organizationId\)/);
  assert.match(source, /\.in\("assigned_to", memberIds\)/);
  assert.match(source, /eligibleProfilesQuery\.in\("id", memberIds\)/);
});

test("COS signing rejects unresolved and cross-organization objects", async () => {
  const source = await read("src/app/api/cos/download-url/route.ts");
  assert.match(source, /resolveLeadOrganizationAccess/);
  assert.match(source, /segment === "\.\."/);
  assert.match(source, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(source, /Object not found/);
  assert.doesNotMatch(source, /canAccessLead/);
  assert.doesNotMatch(source, /isAdminOrBoss/);
});

test("overdue notifications and activity reports cannot span organizations", async () => {
  const [cron, report] = await Promise.all([
    read("src/app/api/cron/check-overdue-installments/route.ts"),
    read("src/app/api/activity/daily-report/route.ts"),
  ]);

  assert.match(cron, /\.eq\("organization_id", plan\.organization_id\)/);
  assert.match(cron, /\.from\("memberships"\)/);
  assert.match(cron, /activeProfileIds\.has\(contract\.sales_id\)/);
  assert.match(report, /resolveLeadOrganizationAccess/);
  assert.match(report, /leads!activities_lead_id_fkey!inner\(organization_id\)/);
  assert.match(report, /leads!business_events_lead_id_fkey!inner\(organization_id\)/);
  assert.equal(
    (report.match(/\.eq\("leads\.organization_id", access\.organizationId\)/g) ?? []).length,
    2,
  );
});
