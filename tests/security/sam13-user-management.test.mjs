import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("SAM-13 keeps every user-management entry point behind the shared admin boundary", () => {
  const usersRoute = read("src/app/api/users/route.ts");
  const teamActions = read("src/app/actions/team.ts");
  const teamPage = read("src/app/(dashboard)/team/page.tsx");

  assert.match(usersRoute, /resolveOrganizationMemberAdminAccess\(request\)/);
  assert.match(
    teamActions,
    /resolveOrganizationMemberAdminAccess\(await actionRequest\(\)\)/,
  );
  assert.match(teamPage, /useRequireRole\(\["admin", "boss"\]\)/);
});

test("SAM-13 authorization is fail-closed and now requires an active organization membership", () => {
  const access = read("src/lib/organization-member-admin.ts");

  assert.match(access, /getRequestAuthContext\(request\)/);
  assert.match(access, /organization_context_required/);
  assert.match(access, /!\["admin", "boss"\]\.includes\(context\.role\)/);
  assert.match(access, /organization_admin_required/);
  assert.match(access, /active_organization_membership_required/);
  assert.match(access, /\.eq\("organization_id", organizationId\)/);
  assert.match(access, /\.eq\("user_id", context\.user\.id\)/);
});

test("SAM-13 password reset reuses the server-only admin client", () => {
  const teamActions = read("src/app/actions/team.ts");
  const resetAction = teamActions.slice(
    teamActions.indexOf("export async function resetUserPassword"),
  );

  assert.match(resetAction, /supabaseAdmin\.auth\.admin\.updateUserById/);
  assert.match(resetAction, /requireOrganizationMembership/);
  assert.doesNotMatch(resetAction, /createClient\(/);
  assert.doesNotMatch(resetAction, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("SAM-13 uses one fail-closed finalizer and creates the organization membership", () => {
  const usersRoute = read("src/app/api/users/route.ts");
  const teamActions = read("src/app/actions/team.ts");
  const finalizer = read("src/lib/user-profile-provisioning.ts");
  const createAction = usersRoute.slice(
    usersRoute.indexOf("export async function POST"),
  );
  const addTeamMember = teamActions.slice(
    teamActions.indexOf("export async function addTeamMember"),
    teamActions.indexOf("export async function removeTeamMember"),
  );

  assert.match(createAction, /finalizeTriggerCreatedUserProfile/);
  assert.match(addTeamMember, /finalizeTriggerCreatedUserProfile/);
  assert.match(createAction, /\.from\("memberships"\)/);
  assert.match(addTeamMember, /\.from\('memberships'\)/);
  assert.doesNotMatch(createAction, /\.from\("profiles"\)\s*\.insert\(/);
  assert.doesNotMatch(addTeamMember, /\.from\('profiles'\)\s*\.insert\(/);
  assert.match(finalizer, /\.from\("profiles"\)\s*\.update\(/);
  assert.match(
    finalizer,
    /\.eq\("id", userId\)\s*\.select\("id"\)\s*\.maybeSingle\(\)/,
  );
  assert.match(finalizer, /deleteUser\(userId\)/);
});

test("SAM-13 removes temporary scripts with embedded production account operations", () => {
  for (const path of [
    "revert_passwords.py",
    "scripts/fix-lead-customer-name.ts",
    "scripts/seed-products.ts",
  ]) {
    assert.equal(existsSync(path), false, `${path} must not remain in the repository`);
  }
});

test("SAM-13 secret gate rejects a tracked file missing from the worktree", () => {
  const gate = read("scripts/check-e2e-secrets.mjs");
  assert.match(gate, /tracked file missing from working tree/);
  assert.doesNotMatch(gate, /if \(!existsSync\(filePath\)\) continue;/);
});
