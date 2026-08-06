import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile("supabase/migrations/20260804185311_sam80_shared_operational_services.sql", "utf8");
const rollback = await readFile("supabase/rollback/20260804185311_sam80_shared_operational_services_rollback.sql", "utf8");
const worker = await readFile("src/lib/shared-operations-worker.ts", "utf8");
const uat = await readFile("scripts/uat/sam80-shared-operational-services.mjs", "utf8");
const page = await readFile("src/components/SharedOperationsPanel.tsx", "utf8");
const workbench = await readFile("src/app/(dashboard)/workbench/page.tsx", "utf8");
const summaryRoute = await readFile("src/app/api/operations/summary/route.ts", "utf8");

test("SAM-80 tenant tables are FORCE RLS and organization-bound", () => {
  for (const table of ["shared_work_items", "shared_approval_requests", "shared_timeline_events", "shared_notifications", "shared_outbox", "shared_jobs", "shared_report_snapshots"]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /requested_organization_id\(\)/);
  assert.match(migration, /v4_actor_has_capability/);
  assert.match(migration, /WITH \(security_invoker = true\)/);
});

test("SAM-80 durable queues lease, retry and dead-letter fail closed", () => {
  assert.match(migration, /FOR UPDATE SKIP LOCKED/g);
  assert.match(migration, /lease_expires_at/);
  assert.match(migration, /state = 'dead_letter'/);
  assert.match(migration, /v4_requeue_shared_dead_letter/);
  assert.match(worker, /v4_claim_shared_outbox/);
  assert.match(worker, /v4_complete_shared_job/);
  assert.doesNotMatch(worker, /console\.(log|error)|SUPABASE_SERVICE_ROLE_KEY/);
});

test("SAM-80 approval, timeline and payload boundaries are explicit", () => {
  assert.match(migration, /requested_by <> auth\.uid\(\)/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.shared_timeline_events,\s+public\.shared_report_snapshots TO authenticated/);
  assert.doesNotMatch(migration, /GRANT[^;]*UPDATE[^;]*shared_timeline_events/);
  assert.match(migration, /v4_shared_payload_is_safe/);
  assert.match(migration, /bearer|private-key|authorization/i);
  assert.match(migration, /v4_shared_work_item_guard\(\)[\s\S]*SECURITY DEFINER/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.v4_shared_work_item_guard\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.v4_shared_approval_guard\(\) FROM PUBLIC, anon, authenticated/);
});

test("SAM-80 rollback is staging/test-only and refuses live residue", () => {
  assert.match(rollback, /newme\.environment/);
  assert.match(rollback, /NOT IN \('staging', 'test'\)/);
  assert.match(rollback, /sam80_shared_services_rollback_data_present/);
});

test("SAM-80 UAT binds release, exercises isolation and verifies cleanup", () => {
  assert.match(uat, /\/runner\/release\/manifest\.json/);
  assert.match(uat, /SAM80_EXPECTED_RELEASE_SHA/);
  assert.match(uat, /independent_approval_gate_failed/);
  assert.match(uat, /cross_organization_gate_failed/);
  assert.match(uat, /cleanup: "verified"/);
  assert.doesNotMatch(uat, /console\.(log|error)/);
});

test("SAM-80 UI exposes work, approvals, jobs, notifications and timeline", () => {
  for (const marker of ["Work items", "Approvals", "Jobs", "Notifications", "Immutable timeline"]) {
    assert.match(page, new RegExp(marker));
  }
  assert.match(workbench, /<SharedOperationsPanel \/>/);
});

test("SAM-80 summary exposes only a tenant-scoped dead-letter aggregate", () => {
  assert.match(summaryRoute, /resolveOrganizationAuthorization\(request, "shared\.operations\.read"\)/);
  assert.match(summaryRoute, /supabaseAdmin\s*\.from\("shared_outbox"\)/);
  assert.match(summaryRoute, /select\("id", \{ count: "exact", head: true \}\)/);
  assert.match(summaryRoute, /\.eq\("organization_id", access\.organizationId\)\.eq\("state", "dead_letter"\)/);
  assert.doesNotMatch(summaryRoute, /select\("\*"\)/);
});
