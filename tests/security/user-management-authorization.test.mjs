import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (file) =>
  fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("GET /api/users requires organization admin access and scopes the directory", async () => {
  const api = await read("src/app/api/users/route.ts");
  assert.match(api, /resolveOrganizationMemberAdminAccess\(request\)/);
  assert.match(api, /activeOrganizationMemberIds\(access\.organizationId\)/);
  assert.match(api, /\.in\("id", memberIds\)/);
  assert.match(api, /organization_id: access\.organizationId/);
});

test("POST /api/users creates exactly one current-organization membership", async () => {
  const api = await read("src/app/api/users/route.ts");
  const post = api.slice(api.indexOf("export async function POST"));
  assert.match(post, /resolveOrganizationMemberAdminAccess\(request\)/);
  assert.match(post, /\.from\("memberships"\)/);
  assert.match(post, /organization_id: access\.organizationId/);
  assert.match(post, /invited_by_membership_id: access\.callerMembershipId/);
});

test("shared organization admin boundary rejects missing context, wrong role, and missing membership", async () => {
  const access = await read("src/lib/organization-member-admin.ts");
  assert.match(access, /getRequestAuthContext\(request\)/);
  assert.match(access, /organization_context_required/);
  assert.match(access, /organization_admin_required/);
  assert.match(access, /active_organization_membership_required/);
});

for (const actionName of [
  "addTeamMember",
  "removeTeamMember",
  "resetUserPassword",
]) {
  test(`${actionName} Server Action requires the shared organization admin boundary`, async () => {
    const action = await read("src/app/actions/team.ts");
    const section = action.slice(action.indexOf(`function ${actionName}`));
    assert.match(
      section,
      /resolveOrganizationMemberAdminAccess\(await actionRequest\(\)\)/,
    );
    if (actionName !== "addTeamMember") {
      assert.match(section, /requireOrganizationMembership/);
    }
  });
}

test("deactivated user is blocked at proxy level for all protected routes", async () => {
  const proxy = await read("src/proxy.ts");
  assert.match(proxy, /import { isActiveProfile }/);
  assert.match(proxy, /if \(!isActiveProfile\(profile\)\)/);
  assert.match(proxy, /inactive_account/);
});

test("proxy selects is_active when querying profiles", async () => {
  const proxy = await read("src/proxy.ts");
  assert.match(proxy, /select\("role, is_active, password_changed_at"\)/);
});

test("team page UI requires admin or boss role", async () => {
  const page = await read("src/app/(dashboard)/team/page.tsx");
  assert.match(page, /useRequireRole\(\["admin", "boss"\]\)/);
  assert.doesNotMatch(page, /useRequireRole\(\["admin", "boss", "sales"\]\)/);
});

test("no unguarded PATCH /api/users endpoint exists", async () => {
  const api = await read("src/app/api/users/route.ts");
  assert.doesNotMatch(api, /export async function PATCH/);
  assert.doesNotMatch(api, /export async function PUT/);
});

test("UI, API, and Server Actions share the same organization-aware manager boundary", async () => {
  const [api, action, page] = await Promise.all([
    read("src/app/api/users/route.ts"),
    read("src/app/actions/team.ts"),
    read("src/app/(dashboard)/team/page.tsx"),
  ]);
  assert.match(api, /resolveOrganizationMemberAdminAccess\(request\)/);
  assert.match(
    action,
    /resolveOrganizationMemberAdminAccess\(await actionRequest\(\)\)/,
  );
  assert.match(page, /useRequireRole\(\["admin", "boss"\]\)/);
});
