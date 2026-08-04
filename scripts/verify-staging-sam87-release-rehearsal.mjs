#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PHASES = [
  "frozen_sha",
  "immutable_artifact",
  "migration_compatibility",
  "isolated_candidate",
  "smoke_readiness",
  "uat_product_saas",
  "uat_sam78",
  "observe_sam68",
  "observe_sam54",
  "rollback",
];

export class Sam87RehearsalError extends Error {
  constructor(code) {
    super(code);
    this.name = "Sam87RehearsalError";
    this.code = code;
  }
}

function fail(code) {
  throw new Sam87RehearsalError(code);
}

function exactKeys(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function requireSha(value, code) {
  if (!SHA.test(value ?? "")) fail(code);
  return value;
}

function requireDigest(value, code) {
  if (!SHA256.test(value ?? "")) fail(code);
  return value;
}

function validatePhase(phase, expectedName) {
  if (!exactKeys(phase, ["name", "status"]) || phase.name !== expectedName || phase.status !== "passed") {
    fail(`phase_${expectedName}_invalid`);
  }
}

/**
 * Validates only a completed, staging-only release rehearsal transcript. The
 * controller, not this parser, performs build/deploy/UAT/rollback operations.
 */
export function validateSam87Rehearsal(body) {
  if (!exactKeys(body, [
    "artifact", "candidate", "linearId", "migration", "phases",
    "previousReleaseSha", "releaseSha", "schemaVersion", "target", "uat",
  ])) fail("evidence_shape_invalid");
  if (body.schemaVersion !== 1 || body.linearId !== "SAM-87" || body.target !== "staging-only") {
    fail("evidence_identity_invalid");
  }
  const releaseSha = requireSha(body.releaseSha, "release_sha_invalid");
  const previousReleaseSha = requireSha(body.previousReleaseSha, "previous_release_sha_invalid");
  if (releaseSha === previousReleaseSha) fail("previous_release_must_differ");

  if (!exactKeys(body.artifact, ["immutable", "sha256"]) || body.artifact.immutable !== true) {
    fail("artifact_binding_invalid");
  }
  const artifactSha256 = requireDigest(body.artifact.sha256, "artifact_digest_invalid");

  if (!exactKeys(body.migration, ["decision", "deltaPaths"])) fail("migration_binding_invalid");
  if (body.migration.decision !== "not_required_no_migration_delta" || !Array.isArray(body.migration.deltaPaths) || body.migration.deltaPaths.length !== 0) {
    fail("migration_decision_invalid");
  }

  if (!exactKeys(body.candidate, ["health", "port", "readiness"]) || body.candidate.port !== 3102 || body.candidate.health !== 200 || body.candidate.readiness !== 200) {
    fail("candidate_binding_invalid");
  }

  if (!exactKeys(body.uat, ["productSaasSha256", "sam54Sha256", "sam68Sha256", "sam78Sha256"])) {
    fail("uat_binding_invalid");
  }
  for (const [key, digest] of Object.entries(body.uat)) requireDigest(digest, `uat_${key}_invalid`);

  if (!Array.isArray(body.phases) || body.phases.length !== PHASES.length) fail("phase_sequence_invalid");
  body.phases.forEach((phase, index) => validatePhase(phase, PHASES[index]));

  return {
    schemaVersion: 1,
    linearId: "SAM-87",
    target: "staging-only",
    releaseSha,
    previousReleaseSha,
    artifact: { immutable: true, sha256: artifactSha256 },
    migration: { decision: body.migration.decision, deltaPaths: [] },
    candidate: { port: 3102, health: 200, readiness: 200 },
    uat: body.uat,
    phases: body.phases,
    rollback: { status: "passed", restoredReleaseSha: previousReleaseSha },
    safety: {
      productionTouched: false,
      databaseRollbackAttempted: false,
      automaticStopAndRollback: true,
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.length !== 3) {
    console.error("SAM-87 staging rehearsal failed: unexpected_arguments");
    process.exitCode = 64;
  } else {
    try {
      const body = JSON.parse(await readFile(process.argv[2], "utf8"));
      console.log(JSON.stringify(validateSam87Rehearsal(body)));
    } catch (error) {
      const code = error instanceof Sam87RehearsalError ? error.code : "invalid_evidence_json";
      console.error(`SAM-87 staging rehearsal failed: ${code}`);
      process.exitCode = 1;
    }
  }
}
