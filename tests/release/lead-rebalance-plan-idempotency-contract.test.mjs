import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const migration = read("supabase/migrations/20260817230000_lead_rebalance_plan_idempotency.sql");
const route = read("src/app/api/dashboard/sales-load/rebalance/route.ts");
const gate = read("supabase/replay/27_lead_rebalance_plan_idempotency.sh");
const harness = read("scripts/replay-migrations.sh");
const manifest = JSON.parse(read("infra/release/release-manifest.json"));
const assertions = read("supabase/replay/10_assert_release_contracts.sql");

test("rebalance batches are immutable, actor-scoped and off the end-user table surface", () => {
  assert.match(migration, /primary key \(actor_id, batch_key\)/i);
  assert.match(migration, /alter table public\.lead_rebalance_batches force row level security/i);
  assert.match(
    migration,
    /revoke all on table public\.lead_rebalance_batches from public, anon, authenticated, service_role;/i,
  );
  assert.match(migration, /grant select on table public\.lead_rebalance_batches to service_role;/i);
  assert.match(migration, /create trigger trg_require_current_session[\s\S]*?on public\.lead_rebalance_batches/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|truncate|all).*lead_rebalance_batches/i);
});

test("the RPC checks the current session first, serializes one actor/key and returns the stored winner", () => {
  assert.match(
    migration,
    /begin\s+perform public\.assert_current_session_at_entry\(\);/i,
  );
  const lockAt = migration.indexOf("pg_catalog.pg_advisory_xact_lock");
  const lookupAt = migration.indexOf("select b.plan into v_existing");
  const insertAt = migration.indexOf("insert into public.lead_rebalance_batches");
  assert.ok(lockAt > 0 && lookupAt > lockAt && insertAt > lookupAt);
  assert.match(migration, /if found then\s+return pg_catalog\.jsonb_build_object\('found', true, 'plan', v_existing\);/i);
  assert.match(migration, /coalesce\(v_actor_role, ''\) not in \('admin', 'boss'\)/i);
  assert.match(
    migration,
    /revoke all on function public\.get_or_create_lead_rebalance_plan\(uuid, jsonb\)[\s\S]*?grant execute[\s\S]*?to authenticated;/i,
  );
});

test("stored plans contain identifiers and exact mutation keys but no durable names or email labels", () => {
  for (const key of ["updates", "untokened_lead_ids", "source_ids", "target_ids", "idempotency_key"]) {
    assert.match(migration, new RegExp(key));
    assert.match(route, new RegExp(key));
  }
  assert.doesNotMatch(migration, /source_names|target_names/i);
  assert.doesNotMatch(route, /source_names|target_names/i);
  assert.match(migration, /count\(distinct \(item ->> 'idempotency_key'\)::uuid\)/i);
  assert.match(migration, /on \(u\.item ->> 'id'\)::uuid = \(n\.item #>> '\{\}'\)::uuid/i);
  assert.match(migration, /where \(t\.item #>> '\{\}'\)::uuid = \(u\.item ->> 'assigned_to'\)::uuid/i);
  assert.match(migration, /where not exists \([\s\S]*?target_ids[\s\S]*?assigned_to/i);
});

test("the route looks up before business reads, claims once and executes only returned plan keys", () => {
  const lookupAt = route.indexOf('"get_or_create_lead_rebalance_plan"');
  const repsAt = route.indexOf('.from("profiles")', lookupAt);
  const claimAt = route.indexOf('"get_or_create_lead_rebalance_plan"', lookupAt + 1);
  const executeAt = route.indexOf('"reassign_lead_atomic"');
  assert.ok(lookupAt > 0 && repsAt > lookupAt && claimAt > repsAt && executeAt > claimAt);
  assert.match(route, /p_idempotency_key: update\.idempotency_key/);
  assert.match(route, /eligibleRepsQuery\.order\("id"/);
  assert.match(route, /\.is\("last_contact_date", null\)\s*\.order\("id"/);
});

test("PG17 gate is wired and measures wait, rollback, empty replay, ACL and residue", () => {
  assert.match(gate, /wait_event_type='Lock'/);
  assert.match(gate, /\[ "\$digest_a" = "\$expected_a" \]/);
  assert.match(gate, /rollback;/);
  assert.match(gate, /PLAN_EMPTY/);
  assert.match(gate, /service_role wrote the immutable plan table/);
  assert.match(gate, /fixture rows remained after cleanup/);
  assert.match(harness, /27_lead_rebalance_plan_idempotency\.sh/);
  assert.match(harness, /EXPECT=fixed bash "\$LEAD_REBALANCE_PLAN_GATE"/);
});

test("both production postures verify the exact live rebalance table, RPC body and ACL boundary", () => {
  const required = manifest.posture.required_for_app.predicates.find(
    ({ name }) => name === "lead-rebalance-plan-boundary-is-installed",
  );
  const strict = manifest.posture.deferred_contract.predicates.find(
    ({ name }) => name === "strict-lead-rebalance-plan-boundary-is-installed",
  );
  assert.ok(required);
  assert.ok(strict);
  assert.equal(strict.sql, required.sql);
  for (const marker of [
    "relforcerowsecurity",
    "trg_require_current_session",
    "(t.tgtype & 1) = 0",
    "(t.tgtype & 2) = 2",
    "(t.tgtype & 28) = 28",
    "t.tgattr::text = ''",
    "t.tgqual is null",
    "service_role",
    "array['SELECT']",
    "has_table_privilege('authenticated', c.oid, 'select')",
    "has_table_privilege('authenticated', c.oid, 'references')",
    "has_table_privilege('authenticated', c.oid, 'trigger')",
    "has_table_privilege('authenticated', c.oid, 'maintain')",
    "has_table_privilege('service_role', c.oid, 'references')",
    "has_table_privilege('service_role', c.oid, 'trigger')",
    "has_table_privilege('service_role', c.oid, 'maintain')",
    "search_path=\"\"",
    "ba0a12063712c249b3d0e73f1cfcda41152c01be64330e634bd5c0f47950d826",
  ]) {
    assert.ok(required.sql.includes(marker), `posture omitted ${marker}`);
  }
  assert.match(assertions, /p\.proconfig = array\['search_path=""'\]::text\[\]/);
  assert.match(assertions, /pg_catalog\.chr\(10\) \|\| 'begin'/);
  assert.match(assertions, /\(t\.tgtype & 1\) = 0[\s\S]*?\(t\.tgtype & 2\) = 2[\s\S]*?\(t\.tgtype & 28\) = 28[\s\S]*?t\.tgattr::text = ''[\s\S]*?t\.tgqual is null/);
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const privilege of ["references", "trigger", "maintain"]) {
      assert.ok(
        assertions.includes(`has_table_privilege('${role}', c.oid, '${privilege}')`),
        `release assertion omitted effective ${role} ${privilege}`,
      );
      assert.ok(
        required.sql.includes(`has_table_privilege('${role}', c.oid, '${privilege}')`),
        `production posture omitted effective ${role} ${privilege}`,
      );
      assert.ok(
        gate.includes(`has_table_privilege('${role}', c.oid, '${privilege}')`),
        `PG17 gate omitted effective ${role} ${privilege}`,
      );
    }
  }
});
