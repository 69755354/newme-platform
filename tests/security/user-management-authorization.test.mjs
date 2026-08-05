import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (file) => fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");

// ─── API route: GET/POST /api/users ──────────────────────────
test("GET /api/users requires admin or boss role", async () => {
  const api = await read("src/app/api/users/route.ts");
  // checkRole() guards the entire handler
  assert.match(api, /checkRole\(request\)/);
  // Non-admin/boss → 403
  assert.match(api, /profile\.role !== "admin" && profile\.role !== "boss"/);
  assert.match(api, /Insufficient permissions\. Admin or Boss role required/);
  // No backdoor for other roles
  assert.doesNotMatch(api, /profile\.role === "sales"/);
  assert.doesNotMatch(api, /profile\.role === "operator"/);
  assert.doesNotMatch(api, /profile\.role === "designer"/);
  assert.doesNotMatch(api, /profile\.role === "finance"/);
});

test("POST /api/users requires admin or boss role", async () => {
  const api = await read("src/app/api/users/route.ts");
  // POST handler calls checkRole and returns 403 on failure
  assert.match(api, /callerRole = await checkRole\(request\)/);
  assert.match(api, /callerRole instanceof NextResponse/);
});

test("API checkRole rejects unauthorized (401) and wrong role (403) separately", async () => {
  const api = await read("src/app/api/users/route.ts");
  // No auth → 401
  assert.match(api, /{ error: "Unauthorized" }, { status: 401 }/);
  // Wrong role → 403
  assert.match(api, /{ status: 403 }/);
});

// ─── Server Actions ─────────────────────────────────────────
test("addTeamMember Server Action requires admin or boss", async () => {
  const action = await read("src/app/actions/team.ts");
  assert.match(action, /\['admin', 'boss'\]\.includes\(profile\.role\)/);
  assert.match(action, /throw new Error\('Forbidden'\)/);
  // No wider role grant
  assert.doesNotMatch(action, /'sales'\]\.includes/);
  assert.doesNotMatch(action, /'operator'\]\.includes/);
});

test("removeTeamMember Server Action requires admin or boss", async () => {
  const action = await read("src/app/actions/team.ts");
  // Second role check (removeTeamMember has its own)
  const removeMember = action.slice(action.indexOf("removeTeamMember"));
  assert.match(removeMember, /\['admin', 'boss'\]\.includes\(caller\.role\)/);
  assert.match(removeMember, /throw new Error\('Forbidden'\)/);
});

test("resetUserPassword Server Action requires admin or boss", async () => {
  const action = await read("src/app/actions/team.ts");
  const resetPw = action.slice(action.indexOf("resetUserPassword"));
  assert.match(resetPw, /\['admin', 'boss'\]\.includes\(profile\.role\)/);
  assert.match(resetPw, /throw new Error\('Forbidden'\)/);
});

// ─── Deactivated user gate ──────────────────────────────────
test("deactivated user is blocked at proxy level for all protected routes", async () => {
  const proxy = await read("src/proxy.ts");
  // isActiveProfile imported and used
  assert.match(proxy, /import { isActiveProfile }/);
  assert.match(proxy, /if \(!isActiveProfile\(profile\)\)/);
  assert.match(proxy, /inactive_account/);
});

test("proxy selects is_active when querying profiles", async () => {
  const proxy = await read("src/proxy.ts");
  // Profile queries include is_active field
  assert.match(proxy, /select\("role, is_active/);
  assert.match(proxy, /select=id,is_active,role/);
});

// ─── UI gating ──────────────────────────────────────────────
test("team page UI requires admin or boss role", async () => {
  const page = await read("src/app/(dashboard)/team/page.tsx");
  assert.match(page, /useRequireRole\(\["admin", "boss"\]\)/);
  // No wider access
  assert.doesNotMatch(page, /useRequireRole\(\["admin", "boss", "sales"\]\)/);
});

// ─── PATCH (modify user) — verify no unguarded endpoint ──────
test("no unguarded PATCH /api/users endpoint exists", async () => {
  const api = await read("src/app/api/users/route.ts");
  assert.doesNotMatch(api, /export async function PATCH/);
  assert.doesNotMatch(api, /export async function PUT/);
});

// ─── Regression: existing checks still valid ─────────────────
test("only admin and boss can manage users through UI, API, and Server Action", async () => {
  const [api, action, page] = await Promise.all([
    read("src/app/api/users/route.ts"),
    read("src/app/actions/team.ts"),
    read("src/app/(dashboard)/team/page.tsx"),
  ]);

  assert.match(api, /profile\.role !== "admin" && profile\.role !== "boss"/);
  assert.doesNotMatch(api, /profile\.role !== "sales"/);
  assert.match(action, /\['admin', 'boss'\]\.includes\(profile\.role\)/);
  assert.doesNotMatch(action, /\['admin', 'boss', 'sales'\]/);
  assert.match(page, /useRequireRole\(\["admin", "boss"\]\)/);
});
