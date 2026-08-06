import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("scripts/uat/v4-staging-acceptance.mjs", "utf8");
const controller = await readFile("scripts/newme-staging-control.sh", "utf8");

test("SAM-80 staging acceptance never accepts production or unbound releases", () => {
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(source, /manifest\?\.git_sha !== config\.releaseSha/);
  assert.match(source, /response\.status !== 200/);
});

test("SAM-80 creates requester and approver identities inside the SHA-bound runner", () => {
  assert.match(source, /createOrganizationActor\(state, \{/);
  assert.match(source, /roleKey: "sales_agent", suffix: "sam80-requester"/);
  assert.match(source, /state\.actor\.token/);
  assert.match(source, /signInWithPassword/);
  assert.doesNotMatch(source, /SAM80_REQUESTER_TOKEN|SAM80_APPROVER_TOKEN|SAM80_ORGANIZATION_ID/);
  assert.match(source, /sam80_independent_approval_gate_failed/);
  assert.match(source, /sam80_cross_organization_gate_failed/);
  assert.match(source, /job\.status !== 202/);
  assert.doesNotMatch(source, /job\.status !== 201/);
  assert.match(source, /sam80_report_job_failed/);
  for (const code of ["sam80_timeline_read_failed", "sam80_summary_read_failed", "sam80_jobs_read_failed", "sam80_report_job_visibility_failed"]) assert.match(source, new RegExp(code));
  assert.match(source, /function httpFailureCode\(response, label\)/);
  assert.match(source, /\^\[a-z0-9_\]\{1,64\}\$\/i/);
  assert.match(controller, /const scenarios = \["SAM-80", "SAM-81", "SAM-82", "SAM-83", "SAM-84", "SAM-86"\]/);
});

test("SAM-80 staging acceptance uses exact identifiers and dependency-ordered cleanup", () => {
  const cleanup = source.slice(source.indexOf("async function cleanup"));
  for (const table of ["shared_report_snapshots", "shared_notifications", "shared_outbox", "shared_timeline_events", "shared_approval_requests", "shared_jobs", "shared_work_items"]) assert.match(cleanup, new RegExp(`"${table}"`));
  assert.match(source, /\.in\("id", values\)/);
  assert.match(source, /collectSam80Cleanup\(state\)/);
  assert.doesNotMatch(cleanup, /truncate|delete\(\)\.neq/i);
  assert.ok(cleanup.indexOf('"shared_report_snapshots"') < cleanup.indexOf('"shared_work_items"'));
  assert.ok(cleanup.indexOf('"shared_work_items"') < cleanup.indexOf('"memberships"'));
});
