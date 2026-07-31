import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(
  new URL(`../../${path}`, import.meta.url),
  "utf8",
);

test("SAM-14 lifecycle is a private service-role RPC with atomic start and end audits", async () => {
  const [migration, rollback, databaseTest, databaseTypes] = await Promise.all([
    read("supabase/migrations/20260730225759_sam14_platform_support_session_lifecycle.sql"),
    read("supabase/rollback/20260730225759_sam14_platform_support_session_lifecycle_rollback.sql"),
    read("tests/database/sam14-platform-support-session-lifecycle.sql"),
    read("src/types/database.ts"),
  ]);

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.start_support_session_atomic/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.end_support_session_atomic/);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public, pg_temp/);
  assert.match(migration, /support\.session\.start/);
  assert.match(migration, /support\.session\.end/);
  assert.match(migration, /support_reason_required/);
  assert.match(migration, /support_expiry_invalid/);
  assert.match(migration, /interval '4 hours'/);
  assert.match(migration, /independent_support_approver_required/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.start_support_session_atomic[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.start_support_session_atomic[\s\S]*TO service_role/);

  const startInsert = migration.indexOf("INSERT INTO public.support_sessions");
  const startAudit = migration.indexOf("'support.session.start'");
  const endAudit = migration.indexOf("'support.session.end'");
  const endUpdate = migration.indexOf("UPDATE public.support_sessions");
  assert.ok(startInsert >= 0 && startAudit > startInsert);
  assert.ok(endAudit >= 0 && endUpdate > endAudit);

  assert.match(databaseTest, /sam14_harness_audit_unavailable/);
  assert.match(databaseTest, /audit failure left an active support session/);
  assert.match(databaseTest, /failed end audit changed the support session/);
  assert.match(databaseTest, /company admin gained platform support state/);

  assert.match(rollback, /sam14_rollback_requires_staging_or_test/);
  assert.match(rollback, /sam14_rollback_active_support_sessions/);
  assert.match(databaseTypes, /start_support_session_atomic:/);
  assert.match(databaseTypes, /end_support_session_atomic:/);
});

test("SAM-14 API binds the authenticated user to private lifecycle RPCs", async () => {
  const [route, access, users, uat, controller] = await Promise.all([
    read("src/app/api/platform/support-sessions/route.ts"),
    read("src/lib/lead-organization-access.ts"),
    read("src/app/api/users/route.ts"),
    read("scripts/uat/sam20-lead-organization-isolation.mjs"),
    read("scripts/newme-staging-control.sh"),
  ]);

  assert.match(route, /getRequestAuthContext\(request\)/);
  assert.match(route, /p_actor_user_id: context\.user\.id/);
  assert.match(route, /"start_support_session_atomic"/);
  assert.match(route, /"end_support_session_atomic"/);
  assert.doesNotMatch(route, /\.from\("platform_staff"\)\.insert/);
  assert.doesNotMatch(route, /SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_URL/);

  const objectAudit = access.indexOf('.from("audit_events").insert');
  const objectGrant = access.lastIndexOf("supportSessionId,");
  assert.ok(objectAudit >= 0 && objectGrant > objectAudit);
  assert.match(access, /support_audit_required/);
  assert.match(users, /const VALID_ROLES = \[[\s\S]*"finance",[\s\S]*\]/);
  assert.doesNotMatch(users, /"platform_staff"/);

  for (const [marker, count] of [
    ["boundedReasonAndExpiry", 1],
    ["companyAdminDeniedPlatformRole", 2],
    ["startAudit", 1],
    ["objectAudit", 1],
    ["endAudit", 1],
    ["endedSessionDenied", 1],
  ]) {
    assert.match(uat, new RegExp(marker));
    assert.match(controller, new RegExp(`${marker} !== ${count}`));
  }
});
