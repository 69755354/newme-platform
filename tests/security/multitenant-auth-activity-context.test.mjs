import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260802055200_multitenant_auth_activity_context.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollback = await readFile(
  new URL(
    "../../supabase/rollback/20260802055200_multitenant_auth_activity_context_rollback.sql",
    import.meta.url,
  ),
  "utf8",
);
const gate = await readFile(
  new URL("../../scripts/run-sam23-database-gate.mjs", import.meta.url),
  "utf8",
);

test("auth login never forges a zero or ambiguous organization", () => {
  assert.match(migration, /active_membership_count <> 1/);
  assert.match(migration, /resolved_organization_id, NEW\.id, CURRENT_DATE/);
  assert.doesNotMatch(
    migration.match(/CREATE OR REPLACE FUNCTION public\.handle_auth_login\(\)[\s\S]*?\$\$;/)?.[0] ?? "",
    /00000000-0000-0000-0000-000000000000/,
  );
  assert.match(migration, /ON CONFLICT \(tenant_id, user_id, session_date\)/);
});

test("request activity requires an authorized selected organization", () => {
  assert.match(migration, /selected_organization_id uuid := public\.requested_organization_id\(\)/);
  assert.match(migration, /organization_context_required/);
  assert.match(migration, /organization_access_denied/);
  assert.match(migration, /membership\.organization_id = selected_organization_id/);
  assert.match(migration, /membership\.user_id = actor_user_id/);
});

test("read-only organizations retain audit visibility while business writes stay frozen", () => {
  assert.match(migration, /TG_TABLE_NAME IN \('activity_logs', 'user_session_daily'\)/);
  assert.match(migration, /organization_status NOT IN \('active', 'read_only', 'suspended'\)/);
  assert.match(migration, /organization_status IS DISTINCT FROM 'active'/);
  assert.match(migration, /organization_is_not_writable/);
});

test("rollback and disposable database verification fail closed", () => {
  assert.match(rollback, /multitenant_auth_activity_rollback_requires_staging_or_test/);
  assert.match(rollback, /multitenant_auth_activity_rollback_would_collapse_organizations/);
  assert.match(gate, /multitenant_auth_activity_fixture/);
  assert.match(gate, /multitenant_auth_activity_failed_rollback_atomicity/);
  assert.match(gate, /multitenant_auth_activity_rollback/);
});
