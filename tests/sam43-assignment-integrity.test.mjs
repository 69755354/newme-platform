import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * The same source with its block comments removed.
 *
 * "This statement is not in the file" has to be a statement about the code. The
 * R6 headers quote the defective statements they replaced — that is what makes
 * them readable — and a `doesNotMatch` over the raw text would be satisfied by
 * deleting the explanation instead of by keeping the fix.
 */
const readCode = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, "");

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

test("SAM-43 preserves transfer history atomically without restoring inactive owners as candidates", () => {
  const mutations = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  const data = read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");
  const route = read("src/app/api/leads/[id]/assignment/route.ts");
  const historyRoute = read("src/app/api/leads/[id]/transfer-history/route.ts");
  const migration = read("supabase/migrations/20260723140000_atomic_lead_reassignment.sql");

  assert.match(mutations, /if \(!newUser\)/);
  assert.match(mutations, /fetch\(`\/api\/leads\/\$\{leadId\}\/assignment`/);
  assert.match(mutations, /expectedUpdatedAt: oldLead\.updated_at/);
  assert.match(mutations, /idempotencyKey: crypto\.randomUUID\(\)/);
  assert.match(data, /filterLeadTransferCandidateQuery\(/);
  assert.match(data, /fetch\(`\/api\/leads\/\$\{leadId\}\/transfer-history`/);
  assert.match(data, /description: describeLeadTransferEvent\(/);
  assert.match(historyRoute, /runAuthorizedLeadTransferRead\(\{/);
  assert.match(historyRoute, /\.from\("leads"\)[\s\S]*\.select\("id, assigned_to"\)[\s\S]*\.eq\("id", leadId\)[\s\S]*\.maybeSingle\(\)/);
  assert.match(historyRoute, /revalidateAccess:[\s\S]*\.eq\("assigned_to", context\.user\.id\)/);
  assert.doesNotMatch(historyRoute, /supabaseAdmin/);
  const authorizationGate = historyRoute.indexOf("runAuthorizedLeadTransferRead({");
  const privilegedRead = historyRoute.indexOf('const { data: transfers');
  assert.ok(authorizationGate >= 0);
  assert.ok(privilegedRead >= 0);
  assert.ok(authorizationGate < privilegedRead);
  assert.match(historyRoute, /\.from\("transfer_history"\)[\s\S]*\.eq\("lead_id", leadId\)/);
  assert.match(historyRoute, /\.from\("profiles"\)[\s\S]*\.in\("id", profileIds\)/);
  assert.match(route, /rpc\("reassign_lead_atomic"/);
  assert.match(migration, /INSERT INTO public\.transfer_history/);
  assert.match(migration, /p_lead_id, v_lead\.assigned_to, p_new_assignee, v_reason, v_actor_id/);
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
  assert.doesNotMatch(actions, /validateAssignmentTarget/);
  assert.doesNotMatch(page, /profiles\.filter\(p => p\.role === 'sales'\)/);

  // R6 · assignments and unassignments go through dedicated audited routines.
  // What these assertions cannot show is that the comparison *works* — that is
  // tests/security/lead-transfer-cas-behaviour.test.mjs, which runs these bodies,
  // and supabase/replay/23_lead_assignment_cas.sh, which runs the database.
  assert.match(actions, /rpc\('reassign_lead_atomic'/);
  assert.match(actions, /rpc\('unassign_lead_atomic'/);
  assert.match(actions, /p_expected_updated_at: target\.expectedUpdatedAt/);
  assert.match(actions, /p_idempotency_key: deriveLeadTransferKey\(batchKey, target\.id\)/);
  assert.doesNotMatch(actions, /\.update\(\{ assigned_to: null \}\)/);
  // No unguarded owner write is left anywhere in the code.
  assert.doesNotMatch(
    readCode("src/app/actions/settings.ts"),
    /update\(\{ assigned_to: (userId|targetUserId|toUserId) \}\)/,
  );
  // The screen has to carry the token for the comparison to mean anything.
  assert.match(route, /updated_at/);
  assert.match(page, /expectedUpdatedAt: lead\.updated_at/);
});

test("SAM-43 rebalance uses eligible targets and never reports failed updates as transferred", () => {
  const route = read("src/app/api/dashboard/sales-load/rebalance/route.ts");

  assert.match(route, /filterLeadTransferCandidateQuery\(/);
  assert.match(route, /is_active/);
  assert.match(route, /transferred\+\+/);
  assert.match(route, /failed: failedLeadIds\.length/);
  assert.doesNotMatch(route, /transferred: updates\.length/);

  // R6 · the round-robin is executed by the audited routine, with the token read
  // alongside the plan and one derived idempotency key per lead. The direct
  // `update({ assigned_to })` this route used to run is gone, and with it the
  // three defects it carried: no comparison, no transfer_history, no idempotence.
  assert.match(route, /rpc\("reassign_lead_atomic"/);
  assert.match(route, /rpc\(\s*"get_or_create_lead_rebalance_plan"/);
  assert.match(route, /\.select\("id, assigned_to, customer_name, updated_at"\)/);
  assert.match(route, /p_expected_updated_at: update\.expected_updated_at/);
  assert.match(route, /idempotency_key: deriveLeadTransferKey\(batchKey, lead\.id\)/);
  assert.match(route, /p_idempotency_key: update\.idempotency_key/);
  assert.match(route, /readLeadTransferBatchKey\(\{/);
  assert.doesNotMatch(
    readCode("src/app/api/dashboard/sales-load/rebalance/route.ts"),
    /\.update\(\{ assigned_to/,
  );
  // A refusal and a replay are reported, never counted as work done.
  assert.match(route, /conflicts: conflictLeadIds\.length/);
  assert.match(route, /replayed\+\+/);
  // And the caller supplies the batch key the derivation needs.
  const caller = read("src/app/(dashboard)/analytics/_components/SalesLoad.tsx");
  assert.match(caller, /const batchKey = batchKeyRef\.current/);
  assert.match(caller, /body: JSON\.stringify\(\{ batchKey \}\)/);
  assert.match(caller, /acquireLeadRebalanceBatchKey\(\s*window\.sessionStorage/);
  assert.match(caller, /acquireLeadRebalanceBatchKey\([\s\S]*?window\.sessionStorage,[\s\S]*?actorId \?\? ""/);
  assert.match(caller, /clearLeadRebalanceBatchKey\(window\.sessionStorage, actorId \?\? "", batchKey\)/);
  assert.match(caller, /actorId=\{userId\}/);
  assert.match(caller, /canRebalance=\{role === "admin" \|\| role === "boss"\}/);
  assert.match(caller, /\{canRebalance && \(\s*<button/);
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
      /supabaseAdmin\.auth\.admin\.updateUserById\(\s*(?:userId|id),\s*\{\s*ban_duration:\s*["']876000h["'],?\s*\},?\s*\)/s,
    );
    assert.match(source, /if \(authErr\) throw new Error/);
    assert.match(source, /Failed to revoke auth access/);
  }
});
