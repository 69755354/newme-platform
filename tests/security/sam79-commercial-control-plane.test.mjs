import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-79 migration is versioned, tenant-scoped and fail closed", async () => {
  const migration = await read("supabase/migrations/20260805190000_v4_commercial_control_plane.sql");
  for (const table of [
    "commercial_plan_versions", "organization_subscriptions", "commercial_entitlements",
    "paid_seat_allocations", "commercial_seat_events", "commercial_usage_events",
    "commercial_invoice_references", "commercial_action_requests",
    "commercial_action_events", "commercial_state_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}\\b`));
    assert.match(migration, new RegExp(`public\\.${table}[\\s\\S]*FORCE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /plan_key = 'starter' AND paid_seat_limit = 5 AND organization_limit = 1/);
  assert.match(migration, /plan_key = 'growth' AND paid_seat_limit = 20 AND organization_limit = 3/);
  assert.match(migration, /plan_key = 'scale' AND paid_seat_limit >= 50/);
  assert.match(migration, /invoice_mode text NOT NULL DEFAULT 'manual' CHECK \(invoice_mode = 'manual'\)/);
  assert.match(migration, /source text NOT NULL DEFAULT 'manual' CHECK \(source = 'manual'\)/);
  assert.match(migration, /commercial_independent_approval_required/);
  assert.match(migration, /commercial_seat_limit_reached/);
  assert.match(migration, /commercial_quota_not_configured/);
  assert.match(migration, /commercial_quota_exceeded/);
  assert.match(migration, /UNIQUE \(organization_id, metric_key, idempotency_key\)/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE|ALL)[^;]+TO authenticated/i);
});

test("SAM-79 rollback is staging/test-only and refuses commercial evidence", async () => {
  const rollback = await read("supabase/rollback/20260805190000_v4_commercial_control_plane_rollback.sql");
  assert.match(rollback, /NOT IN \('staging', 'test'\)/);
  assert.match(rollback, /v4_commercial_rollback_live_records_present/);
  assert.match(rollback, /v4_commercial_rollback_subscription_drift/);
  assert.match(rollback, /DROP TABLE public\.commercial_action_events;[\s\S]+DROP TABLE public\.commercial_plan_versions;/);
});

test("SAM-79 API binds actors to sessions and executes only after approval", async () => {
  const route = await read("src/app/api/platform/commercial/route.ts");
  assert.match(route, /getRequestAuthContext\(request\)/);
  assert.match(route, /v4_request_commercial_action/);
  assert.match(route, /v4_approve_commercial_action/);
  assert.match(route, /v4_execute_commercial_action/);
  assert.match(route, /"actor_user_id" in body/);
  assert.match(route, /"approver_user_id" in body/);
  assert.doesNotMatch(route, /SUPABASE_SERVICE_ROLE_KEY|Bearer\s+[A-Za-z0-9]/);
});

test("SAM-79 UI exposes plan, lifecycle, seats, usage and manual invoices", async () => {
  const page = await read("src/app/(dashboard)/settings/commercial/commercial-control-plane.tsx");
  for (const marker of [
    "Paid seats", "Plan and lifecycle", "Entitlements and usage",
    "Manual invoice references", "Independent approval request ID",
  ]) assert.match(page, new RegExp(marker));
  assert.match(page, /subscription\.plan\.change/);
  assert.match(page, /subscription\.state\.transition/);
});

test("SAM-79 disposable database gate includes apply, test and rollback", async () => {
  const runner = await read("scripts/run-sam23-database-gate.mjs");
  for (const marker of [
    "20260805190000_v4_commercial_control_plane.sql",
    "v4-commercial-control-plane.sql",
    "20260805190000_v4_commercial_control_plane_rollback.sql",
    "v4-commercial-control-plane-rollback-verify.sql",
  ]) assert.match(runner, new RegExp(marker));
});

test("SAM-79 is included in exact-release Product/SaaS UAT with residue-zero cleanup", async () => {
  const runner = await read("scripts/uat/product-saas-final.mjs");
  for (const marker of [
    '"SAM-79"', "runSam79(state)", "commercial_quota_exceeded",
    "commercial_action_events", "commercial_usage_events",
    "commercial_invoice_references", "organization_subscriptions",
  ]) assert.ok(runner.includes(marker), `missing UAT marker: ${marker}`);
  assert.match(runner, /billable_seat_limit: 20/);
  assert.match(runner, /invoice_mode: "manual"/);
});
