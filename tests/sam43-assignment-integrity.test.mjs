import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("SAM-43 chooses a deterministic eligible receiver or safely unassigns", async () => {
  const { resolveActiveLeadReassignmentTarget } = await import(
    "../src/lib/lead-reassignment.mjs"
  );
  const calls = [];
  const query = {
    in(column, values) { calls.push(["in", column, values]); return this; },
    eq(column, value) { calls.push(["eq", column, value]); return this; },
    order(column, options) { calls.push(["order", column, options]); return this; },
    limit() { return Promise.resolve({ data: [{ id: "eligible-receiver" }], error: null }); },
  };
  assert.equal(await resolveActiveLeadReassignmentTarget(query), "eligible-receiver");
  assert.deepEqual(calls, [
    ["in", "role", ["sales", "operator", "boss"]],
    ["eq", "is_active", true],
    ["order", "id", { ascending: true }],
  ]);

  const apiDelete = read("src/app/api/users/[id]/route.ts");
  const actionDelete = read("src/app/actions/team.ts");
  for (const source of [apiDelete, actionDelete]) {
    assert.match(source, /resolveActiveLeadReassignmentTarget/);
    assert.match(source, /\.neq\(['"]id['"], (id|userId)\)/);
    assert.match(source, /\.update\(\{ assigned_to: reassignTo \}\)/);
    assert.match(source, /if \(leadErr\) throw new Error/);
    assert.doesNotMatch(source, /role['"].*admin.*is_active/);
  }
});

test("SAM-43 team deletion only deactivates after reassignment succeeds", () => {
  const sources = [
    read("src/app/api/users/[id]/route.ts"),
    read("src/app/actions/team.ts"),
  ];

  for (const source of sources) {
    assert.doesNotMatch(source, /deleted_at/);
    assert.match(source, /\.update\(\{ is_active: false \}\)/);
    assert.match(source, /if \(leadErr\) throw new Error/);
    assert.match(source, /if \(contractErr\) throw new Error/);
    assert.match(source, /if \(profileErr\) throw new Error/);

    const profileUpdate = source.indexOf(".update({ is_active: false })");
    assert.ok(profileUpdate > source.indexOf("if (leadErr) throw new Error"));
    assert.ok(profileUpdate > source.indexOf("if (contractErr) throw new Error"));
  }
});

test("SAM-43 preserves detail history without restoring inactive owners as candidates", () => {
  const mutations = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  const data = read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");

  assert.match(data, /assignee:profiles!fk_leads_assigned_to\(id, full_name, email, role\)/);
  assert.match(data, /assignee_profile: assigneeProfile/);
  assert.match(mutations, /salesUsers\.find\(\(u\) => u\.id === newUserId\)/);
  assert.match(mutations, /if \(!newUser\)/);
  assert.match(data, /filterLeadTransferCandidateQuery\(/);
});

test("SAM-43 exposes only eligible Settings targets while the database rejects invalid assignments", () => {
  const route = read("src/app/api/settings/data/route.ts");
  const page = read("src/app/(dashboard)/settings/page.tsx");
  const actions = read("src/app/actions/settings.ts");
  const migration = read("supabase/migrations/20260719020000_add_leads_project_status.sql");

  assert.match(route, /filterLeadTransferCandidateQuery\(/);
  assert.match(route, /is_active/);
  assert.match(migration, /Lead assignee must be an active transfer candidate/);
  assert.match(migration, /BEFORE INSERT ON public\.leads/);
  assert.match(migration, /BEFORE UPDATE OF assigned_to ON public\.leads/);
  assert.match(actions, /if \(error\) throw new Error\(error\.message\)/);
  assert.doesNotMatch(actions, /validateAssignmentTarget/);
  assert.doesNotMatch(page, /profiles\.filter\(p => p\.role === 'sales'\)/);
});

test("SAM-43 rebalance uses eligible targets and never reports failed updates as transferred", () => {
  const route = read("src/app/api/dashboard/sales-load/rebalance/route.ts");

  assert.match(route, /filterLeadTransferCandidateQuery\(/);
  assert.match(route, /is_active/);
  assert.match(route, /const failedLeadIds: string\[\] = \[\]/);
  assert.match(route, /if \(error \|\| !updated\)/);
  assert.match(route, /transferred\+\+/);
  assert.match(route, /failed: failedLeadIds\.length/);
  assert.doesNotMatch(route, /transferred: updates\.length/);
});

test("SAM-43 enforces eligible assignment on both Lead inserts and reassignment updates", () => {
  const migration = read("supabase/migrations/20260719020000_add_leads_project_status.sql");
  const newLead = read("src/app/(dashboard)/leads/new/page.tsx");
  const authMe = read("src/app/api/auth/me/route.ts");

  assert.match(migration, /TG_OP = 'INSERT'/);
  assert.match(migration, /BEFORE UPDATE OF assigned_to ON public\.leads/);
  assert.match(migration, /BEFORE INSERT ON public\.leads/);
  assert.match(authMe, /select\("role, is_active/);
  assert.match(authMe, /isActive: profile\?\.is_active === true/);
  assert.match(newLead, /fetch\("\/api\/auth\/me"/);
  assert.match(newLead, /isLeadTransferCandidate\(\{/);
  assert.match(newLead, /authContext\?\.isActive === true/);
  assert.match(newLead, /assigned_to: assigneeId/);
  assert.doesNotMatch(newLead, /from\("profiles"\)/);
});


test("SAM-43 deactivation revokes Auth access before reporting success", () => {
  const sources = [
    read("src/app/api/users/[id]/route.ts"),
    read("src/app/actions/team.ts"),
  ];

  for (const source of sources) {
    const profileUpdate = source.indexOf(".update({ is_active: false })");
    const authRevoke = source.indexOf("supabaseAdmin.auth.admin.updateUserById");

    assert.ok(profileUpdate >= 0);
    assert.ok(authRevoke > profileUpdate);
    assert.match(
      source,
      /supabaseAdmin\.auth\.admin\.updateUserById\(\s*(?:userId|id),\s*\{\s*ban_duration:\s*["']876000h["'],?\s*\}\s*,?\s*\)/s,
    );
    assert.match(source, /if \(authErr\) throw new Error/);
    assert.match(source, /Failed to revoke auth access/);
  }
});
