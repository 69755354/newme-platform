import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("SAM-21 rehearses first-organization migration and rollback in disposable PostgreSQL", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-sam21-first-organization-rehearsal.mjs"],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: process.env,
      timeout: 240_000,
    },
  );

  assert.equal(
    result.status,
    0,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  process.stdout.write(result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.canonicalAssets, "verified");
  assert.equal(evidence.aggregateCounts, "preserved");
  assert.equal(evidence.quotationValueTotal, "preserved");
  assert.equal(evidence.leadOwners, "preserved");
  assert.equal(evidence.historyRelationships, "preserved");
  assert.equal(evidence.documentOwnership, "preserved");
  assert.equal(evidence.readonlyReconciliationPrePost, "verified");
  assert.equal(evidence.sam22RollbackEnvironmentGuard, "verified");
  assert.equal(evidence.sam22RollbackFixtureGuard, "verified");
  assert.equal(evidence.sam20RollbackEnvironmentGuard, "verified");
  assert.equal(evidence.sam20RollbackFixtureGuard, "verified");
  assert.equal(evidence.rollback, "verified");
  assert.equal(evidence.oldLeadContract, "verified");
  assert.equal(evidence.harnessCleanup, "verified");
  assert.equal(evidence.applyEvidenceCaptured, "verified");
  assert.equal(evidence.rollbackEvidenceCaptured, "verified");
  assert.deepEqual(evidence.beforeAfter.before, evidence.beforeAfter.after);
});
