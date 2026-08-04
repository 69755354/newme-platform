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

test("support POST requests dual-session approval while revoke remains actor-bound", async () => {
  const [route, closure, fixture, access, users, uat, controller] = await Promise.all([
    read("src/app/api/platform/support-sessions/route.ts"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
    read("tests/database/v4-tenant-lifecycle-closure.sql"),
    read("src/lib/lead-organization-access.ts"),
    read("src/app/api/users/route.ts"),
    read("scripts/uat/sam20-lead-organization-isolation.mjs"),
    read("scripts/newme-staging-control.sh"),
  ]);
  const postRoute = route.slice(
    route.indexOf("export async function POST"),
    route.indexOf("export async function DELETE"),
  );

  assert.match(route, /getRequestAuthContext\(request\)/);
  assert.match(route, /parseSupportSessionApprovalRequest/);
  assert.match(route, /"v4_request_platform_action_approval"/);
  assert.match(route, /p_action_key: "support\.session\.start"/);
  assert.match(route, /function approvalStatus\(message: string\): number \{[\s\S]*CALLER_ERRORS[\s\S]*message\.includes\(code\)[\s\S]*return status/);
  assert.match(route, /\["support_expiry_invalid", 400\]/);
  assert.match(postRoute, /p_request_id: input\.idempotencyKey/);
  assert.match(route, /context\.supabase\.rpc/);
  assert.doesNotMatch(postRoute, /p_approver_user_id|p_actor_user_id|supabaseAdmin/);
  assert.doesNotMatch(postRoute, /"start_support_session_atomic"/);
  assert.match(route, /"end_support_session_atomic"/);
  assert.doesNotMatch(route, /\.from\("platform_staff"\)\.insert/);
  assert.doesNotMatch(route, /SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(closure, /'support\.session\.start'/);
  assert.match(
    closure,
    /WHEN 'support\.session\.start'[\s\S]*start_support_session_atomic\([\s\S]*approval\.payload/,
  );
  assert.match(
    closure,
    /JOIN public\.profiles profile[\s\S]*profile\.is_active IS TRUE/,
  );
  for (const evidence of [
    "inactive profile requested support approval",
    "platform support self-approved support session",
    "inactive profile approved support session",
    "inactive requester profile executed support session",
    "inactive requester replayed consumed support session",
    "inactive consumed replay left support side effects",
    "two-session support approval did not execute atomically",
    "forged support user UUID accepted",
  ]) assert.match(fixture, new RegExp(evidence));

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
    ["independentApproval", 1],
    ["approvalEvents", 3],
    ["selfApprovalDenied", 1],
  ]) {
    assert.match(uat, new RegExp(marker));
    assert.match(controller, new RegExp(`${marker} !== ${count}`));
  }
});

test("support request parser dynamically rejects caller-supplied approver UUIDs", async () => {
  const { parseSupportSessionApprovalRequest } = await import(
    new URL("../../src/lib/support-session-approval-request.ts", import.meta.url)
  );
  const valid = {
    support_user_id: "78000000-0000-4000-8000-000000000016",
    organization_id: "78000000-0000-4000-8000-000000000001",
    ticket_ref: "SAM78-support-parser",
    reason: "Independently approved support access",
    scope: ["lead:read"],
    expires_at: "2026-08-03T12:00:00.000Z",
    idempotency_key: "sam78-support-parser",
  };
  assert.ok(parseSupportSessionApprovalRequest(valid));
  assert.equal(parseSupportSessionApprovalRequest({
    ...valid,
    approver_user_id: "78000000-0000-4000-8000-000000000099",
  }), null);
});
