import assert from "node:assert/strict";
import test from "node:test";
import { validateSam87Rehearsal } from "../../scripts/verify-staging-sam87-release-rehearsal.mjs";

const sha = "a".repeat(40);
const previous = "b".repeat(40);
const digest = (seed) => seed.repeat(64).slice(0, 64);

function evidence() {
  return {
    schemaVersion: 1,
    linearId: "SAM-87",
    target: "staging-only",
    releaseSha: sha,
    previousReleaseSha: previous,
    artifact: { immutable: true, sha256: digest("c") },
    migration: { decision: "not_required_no_migration_delta", deltaPaths: [] },
    candidate: { port: 3102, health: 200, readiness: 200 },
    uat: {
      productSaasSha256: digest("d"), sam78Sha256: digest("e"),
      sam68Sha256: digest("f"), sam54Sha256: digest("1"),
    },
    phases: [
      "frozen_sha", "immutable_artifact", "migration_compatibility",
      "isolated_candidate", "smoke_readiness", "uat_product_saas",
      "uat_sam78", "observe_sam68", "observe_sam54", "rollback",
    ].map((name) => ({ name, status: "passed" })),
  };
}

test("SAM-87 accepts only a serialized immutable staging recovery rehearsal", () => {
  const result = validateSam87Rehearsal(evidence());
  assert.equal(result.rollback.restoredReleaseSha, previous);
  assert.equal(result.safety.automaticStopAndRollback, true);
  assert.equal(result.candidate.port, 3102);
});

test("SAM-87 fails closed for migration, candidate, and phase drift", () => {
  for (const mutate of [
    (body) => { body.migration.deltaPaths.push("supabase/migrations/2026.sql"); },
    (body) => { body.candidate.health = 503; },
    (body) => { body.phases[3].name = "rollback"; },
    (body) => { body.artifact.immutable = false; },
  ]) {
    const body = evidence();
    mutate(body);
    assert.throws(() => validateSam87Rehearsal(body), /Sam87RehearsalError/);
  }
});
