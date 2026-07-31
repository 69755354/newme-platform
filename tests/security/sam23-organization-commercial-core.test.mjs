import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-23 migration owns the complete commercial chain by organization", async () => {
  const migration = await read(
    "supabase/migrations/20260730231446_sam23_organization_owned_commercial_core.sql",
  );

  for (const table of [
    "quotations",
    "contracts",
    "contract_approvals",
    "installment_plans",
    "payments",
    "payment_allocations",
    "projects",
    "tasks",
    "lead_documents",
  ]) {
    assert.match(migration, new RegExp(`'${table}'`));
  }
  assert.match(
    migration,
    /CREATE POLICY sam23_%I_organization_boundary[\s\S]*AS RESTRICTIVE[\s\S]*requested_organization_id\(\)/i,
  );
  assert.match(
    migration,
    /quotations_organization_contract_fkey[\s\S]*contracts \(organization_id, id\)/i,
  );
  assert.match(
    migration,
    /contracts_organization_quotation_fkey[\s\S]*quotations \(organization_id, id\)/i,
  );
  assert.match(
    migration,
    /task_assignee_active_organization_membership_required/,
  );
  assert.match(
    migration,
    /CREATE OR REPLACE VIEW public\.v_sam23_organization_commercial_summary[\s\S]*security_invoker = true/i,
  );
  assert.match(
    migration,
    /FROM public\.organizations organization\s+WHERE organization\.id = public\.requested_organization_id\(\)/,
  );
});

test("SAM-23 seats and initialization are deterministic and fail closed", async () => {
  const migration = await read(
    "supabase/migrations/20260730231446_sam23_organization_owned_commercial_core.sql",
  );

  for (const role of [
    "org_owner",
    "org_admin",
    "manager",
    "sales_agent",
    "operations",
    "finance",
    "specialist",
    "viewer",
    "portal_user",
  ]) {
    assert.ok(migration.includes(`'${role}'`), `missing role ${role}`);
  }
  assert.match(
    migration,
    /count\(DISTINCT membership\.id\)::integer AS seat_count/,
  );
  assert.match(migration, /billable_seat_limit_reached/);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.initialize_organization\(/,
  );
  assert.match(migration, /current_setting\('role', true\) <> 'service_role'/);
  assert.match(migration, /organization_idempotency_payload_mismatch/);
  assert.match(migration, /active_owner_profile_required/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.initialize_organization[\s\S]*FROM PUBLIC, anon, authenticated/i,
  );
});

test("SAM-23 rollback is staging/test-only and preserves the SAM-20 core", async () => {
  const rollback = await read(
    "supabase/rollback/20260730231446_sam23_organization_owned_commercial_core_rollback.sql",
  );
  const rollbackVerify = await read(
    "tests/database/sam23-organization-commercial-rollback-verify.sql",
  );

  assert.match(rollback, /sam23_rollback_requires_staging_or_test/);
  assert.match(rollback, /sam23_rollback_nonlegacy_organizations_not_clean/);
  assert.match(rollback, /sam23_rollback_global_number_collision/);
  assert.match(
    rollback,
    /DROP CONSTRAINT IF EXISTS quotations_organization_contract_fkey/,
  );
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS public\.organizations/);
  assert.doesNotMatch(rollback, /DROP FUNCTION IF EXISTS public\.requested_organization_id/);
  assert.match(rollbackVerify, /column_info\.table_name/);
  assert.doesNotMatch(rollbackVerify, /DECLARE\s+table_name\s+text/);
});

test("SAM-23 disposable database gate is pinned, atomic, and cleans its container", async () => {
  const gate = await read("scripts/run-sam23-database-gate.mjs");

  assert.match(gate, /postgres:17-alpine@sha256:[a-f0-9]{64}/);
  assert.match(gate, /\^      \[A-Za-z0-9_\]\+: \\\{\$\/m/);
  assert.match(gate, /sam23_rollback_fail_closed_contract_failed/);
  assert.match(gate, /sam23_failed_rollback_atomicity/);
  assert.match(gate, /fixture_cleanup: "verified"/);
  assert.match(gate, /command\(\["rm", "--force", container\]\)/);
  assert.doesNotMatch(gate, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(gate, /vfopmpxlhwzpxqegayew/);
});

test("SAM-23 cross-organization insert denial is exact and leaves no residue", async () => {
  const fixture = await read(
    "tests/database/sam23-organization-commercial-core.sql",
  );

  assert.match(fixture, /commercial_parent_organization_missing/);
  assert.match(fixture, /WHEN foreign_key_violation THEN/);
  assert.match(fixture, /cross-organization quotation denial left residue/);
  assert.match(
    fixture,
    /TO authenticated, service_role/,
    "the disposable fixture must preserve the staging service-role cleanup path",
  );
  assert.match(
    fixture,
    /WHERE user_id = '88888888-8888-4888-8888-888888888881'/,
    "the seat-overflow identity's legacy membership must be removed before auth cleanup",
  );
  assert.match(
    fixture,
    /WHERE quote_no = 'SAM23-RLS-CROSS-ORG'/,
  );
});

test("SAM-23 types expose organization ownership, roles, seats, initialization, and reporting", async () => {
  const types = await read("src/types/database.ts");

  for (const token of [
    "roles:",
    "membership_roles:",
    "organization_provisioning_requests:",
    "organization_billable_seat_count:",
    "initialize_organization:",
    "v_sam23_organization_commercial_summary:",
  ]) {
    assert.ok(types.includes(token), `missing database type token ${token}`);
  }
  for (const table of [
    "quotations",
    "contracts",
    "contract_approvals",
    "installment_plans",
    "payments",
    "payment_allocations",
    "projects",
    "tasks",
    "lead_documents",
  ]) {
    assert.match(
      types,
      new RegExp(
        `${table}: \\{[\\s\\S]*?foreignKeyName: "${table}_organization_id_fkey"`,
      ),
    );
  }
});

test("SAM-23 staging UAT is release-bound, synthetic-only, and verifies exact cleanup", async () => {
  const uat = await read("scripts/uat/sam23-organization-commercial-core.mjs");

  assert.match(uat, /EXPECTED_PROJECT_REF = "bfsiibofuzoglziltgyd"/);
  assert.match(uat, /CONFIRMATION = "SAM23_STAGING_ONLY"/);
  assert.match(uat, /RELEASE_MANIFEST_PATH = "\/runner\/release\/manifest\.json"/);
  assert.match(uat, /STAGING_BASE_URL = "http:\/\/127\.0\.0\.1:3101"/);
  assert.match(
    uat,
    /STAGING_SUPABASE_URL =\s+`https:\/\/\$\{EXPECTED_PROJECT_REF\}\.supabase\.co`/,
  );
  assert.match(uat, /RELEASE_SHA_PATTERN = \/\^\[0-9a-f\]\{40\}\$\//);
  assert.match(uat, /manifestPath = required\("SAM23_RELEASE_MANIFEST"\)/);
  assert.match(uat, /projectRef = required\("NEWME_STAGING_PROJECT_REF"\)/);
  assert.match(uat, /baseUrl === STAGING_BASE_URL/);
  assert.match(uat, /supabaseUrl === STAGING_SUPABASE_URL/);
  assert.doesNotMatch(uat, /hostname\.startsWith/);
  assert.match(uat, /manifest\?\.git_sha === releaseSha/);
  assert.match(uat, /@invalid\.test/);
  assert.match(uat, /initialize_organization/);
  assert.match(uat, /organization_billable_seat_count/);
  assert.match(uat, /commercial_cross_organization_parent/);
  assert.match(uat, /task_assignee_active_organization_membership_required/);
  assert.match(uat, /v_sam23_organization_commercial_summary/);
  for (const fixture of [
    "organizations",
    "memberships",
    "membership_roles",
    "provisioning_requests",
    "leads",
    "quotations",
    "contracts",
    "installment_plans",
    "payments",
    "contract_approvals",
    "payment_allocations",
    "projects",
    "tasks",
    "lead_documents",
    "activities",
    "business_events",
    "notifications",
    "follow_up_logs",
    "audit_events",
    "profiles",
    "auth_fixtures",
  ]) {
    assert.ok(uat.includes(`${fixture}: 0`), `missing cleanup counter ${fixture}`);
  }
  for (const scope of [
    "organizations_by_marker",
    "provisioning_by_idempotency",
    "leads_by_marker",
    "quotations_by_marker",
    "contracts_by_marker",
    "projects_by_marker",
    "tasks_by_marker",
    "lead_documents_by_marker",
    "auth_users_by_marker",
  ]) {
    assert.ok(uat.includes(`${scope}: 0`), `missing scoped cleanup counter ${scope}`);
  }
  const commercialValues = uat.indexOf("const values = {");
  const commercialTracking = uat.indexOf(
    "trackUnique(commercialIds[table], id)",
    commercialValues,
  );
  const firstCommercialWrite = uat.indexOf(
    'await requireInsert(admin.from("leads").insert',
    commercialValues,
  );
  assert.ok(commercialValues >= 0);
  assert.ok(commercialTracking > commercialValues);
  assert.ok(
    commercialTracking < firstCommercialWrite,
    "commercial UUIDs must be tracked before the first write",
  );
  assert.match(uat, /app_metadata: \{[\s\S]*fixture_scope: FIXTURE_SCOPE/);
  assert.match(uat, /trackUnique\(userEmails, email\)[\s\S]*createUser\(\{/);
  assert.match(
    uat,
    /recoverProvisioningFixtures[\s\S]*organization_provisioning_requests/,
  );
  assert.match(uat, /recoverAuthFixtures[\s\S]*listAllAuthUsers/);
  assert.match(uat, /recoverCommercialFixtures[\s\S]*markerQueries/);
  assert.match(uat, /recover_provisioning[\s\S]*recoverProvisioningFixtures/);
  assert.match(uat, /recover_auth[\s\S]*recoverAuthFixtures/);
  assert.match(uat, /recover_commercial[\s\S]*recoverCommercialFixtures/);
  assert.match(uat, /id: viewerMembershipId/);
  assert.match(uat, /id: crossMembershipId/);
  assert.match(uat, /id: crossContractId/);
  assert.match(uat, /id: crossTaskId/);
  assert.match(
    uat,
    /\.\.\.Object\.entries\(cleanupCounts\),[\s\S]*\.\.\.Object\.entries\(cleanupScopeCounts\)/,
  );
  assert.match(uat, /cleanup: "verified"/);
  assert.doesNotMatch(uat, /vfopmpxlhwzpxqegayew/);
});

test("commercial embeds explicitly select their legacy relationship beside composite ownership FKs", async () => {
  const files = await Promise.all([
    read("src/app/(dashboard)/quotations/[id]/page.tsx"),
    read("src/app/(dashboard)/quotes/quotes-client.tsx"),
    read("src/app/(dashboard)/quotes/page.tsx"),
    read("src/app/api/quotations/[id]/convert/route.ts"),
    read("src/app/api/quotations/export/route.ts"),
    read("src/app/api/contracts/route.ts"),
    read("src/app/api/contracts/list/route.ts"),
    read("src/app/api/analytics/summary/route.ts"),
    read("src/app/api/dashboard/payment-tracker/route.ts"),
    read("src/app/api/payments/list/route.ts"),
    read("src/app/(dashboard)/projects/projects-client.tsx"),
    read("src/app/(dashboard)/projects/page.tsx"),
    read("src/app/api/dashboard/summary/route.ts"),
  ]);
  const source = files.join("\n");

  for (const relationship of [
    "quotations_lead_id_fkey",
    "contracts_lead_id_fkey",
    "installment_plans_contract_id_fkey",
    "payments_contract_id_fkey",
    "fk_projects_lead",
    "tasks_lead_id_fkey",
  ]) {
    assert.ok(
      source.includes(relationship),
      `missing explicit PostgREST relationship hint ${relationship}`,
    );
  }
});
