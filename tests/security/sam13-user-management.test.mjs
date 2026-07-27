import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("SAM-13 limits every user-management entry point to admin and boss", () => {
  const usersRoute = read("src/app/api/users/route.ts");
  const teamActions = read("src/app/actions/team.ts");
  const teamPage = read("src/app/(dashboard)/team/page.tsx");

  assert.match(usersRoute, /profile\.role !== "admin" && profile\.role !== "boss"/);
  assert.doesNotMatch(usersRoute, /profile\.role !== "sales"/);
  assert.match(teamActions, /\['admin', 'boss'\]\.includes\(profile\.role\)/);
  assert.doesNotMatch(teamActions, /\['admin', 'boss', 'sales'\]\.includes\(profile\.role\)/);
  assert.match(teamPage, /useRequireRole\(\["admin", "boss"\]\)/);
});

test("SAM-13 password reset reuses the server-only admin client", () => {
  const teamActions = read("src/app/actions/team.ts");
  const resetAction = teamActions.slice(teamActions.indexOf("export async function resetUserPassword"));

  assert.match(resetAction, /supabaseAdmin\.auth\.admin\.updateUserById/);
  assert.doesNotMatch(resetAction, /createClient\(/);
  assert.doesNotMatch(resetAction, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("SAM-13 uses one fail-closed finalizer for trigger-created profiles", () => {
  const usersRoute = read("src/app/api/users/route.ts");
  const teamActions = read("src/app/actions/team.ts");
  const finalizer = read("src/lib/user-profile-provisioning.ts");
  const createAction = usersRoute.slice(usersRoute.indexOf("export async function POST"));
  const addTeamMember = teamActions.slice(
    teamActions.indexOf("export async function addTeamMember"),
    teamActions.indexOf("export async function removeTeamMember"),
  );

  assert.match(createAction, /finalizeTriggerCreatedUserProfile/);
  assert.match(addTeamMember, /finalizeTriggerCreatedUserProfile/);
  assert.doesNotMatch(createAction, /\.from\("profiles"\)\s*\.insert\(/);
  assert.doesNotMatch(addTeamMember, /\.from\('profiles'\)\s*\.insert\(/);

  assert.match(finalizer, /\.from\("profiles"\)\s*\.update\(/);
  assert.match(finalizer, /\.eq\("id", userId\)\s*\.select\("id"\)\s*\.maybeSingle\(\)/);
  assert.match(finalizer, /profile\?\.id !== userId/);
  assert.match(finalizer, /deleteUser\(userId\)/);
  assert.match(finalizer, /cleanupError/);
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

