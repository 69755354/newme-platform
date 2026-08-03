import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../scripts/v4-rehearsal-kit/cli.mjs";
import { evidenceSchemas, schemaNames } from "../scripts/v4-rehearsal-kit/schemas.mjs";
import {
  V4ValidationError,
  stableDigest,
  validateEvidenceDocument,
  validatePreparationBundle,
} from "../scripts/v4-rehearsal-kit/validators.mjs";

const root = new URL("../", import.meta.url);
const templateUrl = new URL(
  "../scripts/v4-rehearsal-kit/examples/synthetic-preparation-bundle.json",
  import.meta.url,
);
const read = (path) => readFile(new URL(path, root), "utf8");
const fixtureDigest = (label) => stableDigest({ syntheticEvidenceFixture: label });
const fixtureSha1 = (label) => fixtureDigest(label).slice(0, 40);
const FIXTURE_RELEASE_SHA = "f2bd6576a0723fea58a13926baef2dedcc37da8e";
const FIXTURE_TREE_SHA = "eab6472540d9b47e5ff2eb7a59788e3c98929ba3";

async function preparationTemplate() {
  return JSON.parse(await readFile(templateUrl, "utf8"));
}

async function executedSyntheticEvidence() {
  const bundle = await preparationTemplate();
  bundle.mode = "evidence";
  bundle.generatedAt = "2026-08-03T02:02:00.000Z";
  bundle.evidenceState = "verified-current";
  bundle.environmentClass = "synthetic-local";
  bundle.claimsExecuted = true;
  for (const name of [
    "clone", "mapping", "outboundDisable", "migration", "destruction",
    "provenance", "serviceLevel", "restore", "load", "noisyNeighbor", "alert",
  ]) bundle[name].executionStatus = "executed";

  Object.assign(bundle.clone.sourceSnapshot, {
    snapshotRef: "backup-catalog://sam85/run-20260803/snapshot-019fad6c",
    sha256: fixtureDigest("source-snapshot"),
  });

  Object.assign(bundle.clone.approval, {
    status: "approved",
    scopeRef: "approval://change/SAM-85-20260803",
    ownerRef: "iam-role://v4-rehearsal-owner",
    accessRefs: ["iam-role://v4-rehearsal-operator", "iam-role://v4-rehearsal-reviewer"],
    approvedAt: "2026-08-03T00:00:00.000Z",
  });
  bundle.clone.credentialPolicy.credentialRefs = [
    "vault-ref://sam85/clone-db/session-019fad6c",
    "vault-ref://sam85/clone-app/session-019fad6c",
  ];
  Object.assign(bundle.clone.execution, {
    createdAt: "2026-08-03T00:01:00.000Z",
    maskedAt: "2026-08-03T00:02:00.000Z",
    applicationAccessEnabledAt: "2026-08-03T00:03:00.000Z",
  });

  bundle.outboundDisable.channels.forEach((entry, index) => {
    Object.assign(entry.verification, {
      status: "blocked",
      checkedAt: "2026-08-03T00:02:30.000Z",
      evidenceDigest: fixtureDigest(`outbound-${index}`),
    });
  });
  bundle.migration.releaseSha = FIXTURE_RELEASE_SHA;
  bundle.migration.migrations.forEach((entry, index) => {
    entry.forwardSha256 = fixtureDigest(`migration-${index}-forward`);
    entry.rollbackSha256 = fixtureDigest(`migration-${index}-rollback`);
    entry.applyStatus = "passed";
    entry.rollbackStatus = "passed";
  });
  bundle.migration.backfills.forEach((entry) => { entry.status = "passed"; });
  bundle.migration.quarantine.aggregateDigest = fixtureDigest("quarantine-aggregate");
  bundle.migration.reconciliation.forEach((entry, index) => {
    const reconciliationDigest = fixtureDigest(`reconciliation-${index}`);
    entry.beforeDigest = reconciliationDigest;
    entry.afterDigest = reconciliationDigest;
    entry.status = "passed";
  });

  bundle.destruction.resources.forEach((entry, index) => {
    entry.status = ["credentials", "access"].includes(entry.kind) ? "revoked" : "destroyed";
    entry.completedAt = "2026-08-03T02:00:00.000Z";
    entry.evidenceDigest = fixtureDigest(`destruction-${index}`);
  });
  bundle.destruction.verifiedByRef = "independent-reviewer-role";
  bundle.destruction.verifiedAt = "2026-08-03T02:01:00.000Z";

  bundle.provenance.chainStatus = "verified";
  Object.assign(bundle.provenance.source, {
    gitSha: FIXTURE_RELEASE_SHA,
    treeSha: FIXTURE_TREE_SHA,
  });
  Object.assign(bundle.provenance.artifact, {
    artifactRef: "registry://newme/v4-rehearsal/artifact-20260803",
    sha256: fixtureDigest("release-artifact"),
  });
  Object.assign(bundle.provenance.manifest, {
    sha256: fixtureDigest("release-manifest"),
    gitSha: FIXTURE_RELEASE_SHA,
    treeSha: FIXTURE_TREE_SHA,
    artifactSha256: bundle.provenance.artifact.sha256,
  });
  Object.assign(bundle.provenance.runtime, {
    environmentRef: "environment://isolated/v4-rehearsal-001",
    releaseSha: FIXTURE_RELEASE_SHA,
    buildId: FIXTURE_RELEASE_SHA,
    artifactSha256: bundle.provenance.artifact.sha256,
    manifestSha256: bundle.provenance.manifest.sha256,
  });
  bundle.provenance.runtime.observedAt = "2026-08-03T00:04:00.000Z";
  bundle.serviceLevel.decision = "pass";

  Object.assign(bundle.restore, {
    environmentRef: "environment://isolated/restore-20260803",
    backupRef: "backup-catalog://sam86/backup-20260803T000000Z",
    backupMetadataDigest: fixtureDigest("backup-metadata"),
    pitrMetadataDigest: fixtureDigest("pitr-metadata"),
  });
  Object.assign(bundle.restore.timeline, {
    recoveryPointAt: "2026-08-03T00:00:00.000Z",
    failurePointAt: "2026-08-03T00:01:00.000Z",
    restoreStartedAt: "2026-08-03T00:02:00.000Z",
    restoreCompletedAt: "2026-08-03T00:07:00.000Z",
  });
  Object.assign(bundle.restore.measured, { rpoSeconds: 60, rtoSeconds: 300 });
  const restoreDigest = fixtureDigest("restore-validation");
  bundle.restore.validation.beforeDigest = restoreDigest;
  bundle.restore.validation.afterDigest = restoreDigest;
  bundle.restore.status = "passed";
  bundle.load.releaseSha = FIXTURE_RELEASE_SHA;
  bundle.load.dataset.shapeDigest = fixtureDigest("load-dataset-shape");
  bundle.load.status = "passed";
  bundle.noisyNeighbor.releaseSha = FIXTURE_RELEASE_SHA;
  bundle.noisyNeighbor.stressedTenantRef = "tenant://synthetic/tenant-a-20260803";
  bundle.noisyNeighbor.collateralTenantRefs = ["tenant://synthetic/tenant-b-20260803"];
  bundle.noisyNeighbor.observations[0].tenantRef = "tenant://synthetic/tenant-b-20260803";
  bundle.noisyNeighbor.capacityDecision.decision = "accept";
  bundle.noisyNeighbor.capacityDecision.maxSafeConcurrency = 10;
  Object.assign(bundle.alert, {
    releaseSha: FIXTURE_RELEASE_SHA,
    alertRuleRef: "alert-rule://sam86/high-error-rate-v1",
    ownerRef: "iam-role://platform-oncall",
    routeRef: "alert-route://isolated/test-sink-20260803",
    stimulusRef: "stimulus://synthetic/error-rate-20260803",
  });
  Object.assign(bundle.alert.timeline, {
    triggeredAt: "2026-08-03T00:10:00.000Z",
    deliveredAt: "2026-08-03T00:10:10.000Z",
    acknowledgedAt: "2026-08-03T00:10:20.000Z",
  });
  bundle.alert.deliveryLatencyMs = 10_000;
  bundle.alert.status = "passed";
  return bundle;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof V4ValidationError && error.code === code);
}

test("synthetic preparation template is valid and cannot claim execution", async () => {
  const bundle = await preparationTemplate();
  const result = validatePreparationBundle(bundle, { expectedMode: "template" });
  assert.deepEqual(result.linearIds, ["SAM-85", "SAM-86"]);
  assert.equal(result.status, "valid-template");
  assert.equal(result.acceptanceStatus, "not_executed");
  assert.equal(result.claimsExecuted, false);
});

test("all reusable evidence schemas are strict and discoverable", () => {
  assert.deepEqual(schemaNames, [
    "ephemeralClone", "mapping", "outboundDisable", "migration", "destruction",
    "provenance", "serviceLevel", "restore", "load", "noisyNeighbor", "alert", "bundle",
  ]);
  for (const [name, schema] of Object.entries(evidenceSchemas)) {
    assert.equal(schema.type, "object", `${name} must be an object schema`);
    assert.equal(schema.additionalProperties, false, `${name} must reject unknown properties`);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, `urn:newme:v4:schema:${name}:1`);
    assert.ok(Object.isFrozen(schema), `${name} schema must be immutable`);
  }
});

test("synthetic executed fixtures exercise semantics but are refused as evidence by default", async () => {
  const bundle = await executedSyntheticEvidence();
  expectCode(() => validatePreparationBundle(bundle, { expectedMode: "evidence" }), "synthetic_execution_not_evidence");
  const result = validatePreparationBundle(bundle, {
    expectedMode: "evidence",
    allowSyntheticEvidence: true,
  });
  assert.equal(result.status, "valid-evidence");
  assert.equal(result.acceptanceStatus, "passed");
});

test("evidence mode rejects homogeneous digests and placeholder references", async (t) => {
  const cases = [
    ["homogeneous sha256", (b) => { b.clone.sourceSnapshot.sha256 = "a".repeat(64); }, "evidence_placeholder_digest"],
    ["homogeneous git sha", (b) => { b.provenance.source.gitSha = "b".repeat(40); }, "evidence_placeholder_digest"],
    ["placeholder ref", (b) => { b.clone.sourceSnapshot.snapshotRef = "snapshot-placeholder"; }, "evidence_placeholder_reference"],
    ["sample ref", (b) => { b.alert.routeRef = "route/sample/sink"; }, "evidence_placeholder_reference"],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const bundle = await executedSyntheticEvidence();
      mutate(bundle);
      expectCode(() => validatePreparationBundle(bundle, { allowSyntheticEvidence: true }), code);
    });
  }
});

test("secret key and value scanning covers operational credential forms", async (t) => {
  const forbiddenKeys = [
    "api_key", "privateKey", "access-key", "serviceRoleKey",
    "passphrase", "credential", "bearer", "tls_cert",
  ];
  for (const key of forbiddenKeys) {
    await t.test(`key ${key}`, async () => {
      const bundle = await preparationTemplate();
      bundle.restore.validation.counts[key] = 1;
      expectCode(() => validatePreparationBundle(bundle), "forbidden_sensitive_key");
    });
  }

  const forbiddenKeyValues = [
    ["email key", "person@example.test"],
    ["token key", "ghp_0123456789abcdefghij"],
  ];
  for (const [name, key] of forbiddenKeyValues) {
    await t.test(name, async () => {
      const bundle = await preparationTemplate();
      bundle.restore.validation.counts[key] = 1;
      expectCode(() => validatePreparationBundle(bundle), "forbidden_sensitive_value");
    });
  }

  const forbiddenValues = [
    ["bearer", "Bearer abcdefghijklmnop"],
    ["jwt", ["eyJabcdefghij", "eyJabcdefghij", "abcdefghijkl"].join(".")],
    ["known token prefix", "ghp_0123456789abcdefghij"],
    ["userinfo uri", "https://operator:supersensitive@example.invalid/path"],
    ["embedded secret", "service_key=embedded-secret-value"],
    ["private key material", ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join("")],
    ["certificate material", "-----BEGIN CERTIFICATE-----"],
  ];
  for (const [name, value] of forbiddenValues) {
    await t.test(`value ${name}`, async () => {
      const bundle = await preparationTemplate();
      bundle.clone.approval.ownerRef = value;
      expectCode(() => validatePreparationBundle(bundle), "forbidden_sensitive_value");
    });
  }
});

test("failed measured thresholds stay failed instead of being relabelled green", async () => {
  const bundle = await executedSyntheticEvidence();
  bundle.restore.timeline.restoreCompletedAt = "2026-08-03T00:22:00.000Z";
  bundle.restore.measured.rtoSeconds = 1200;
  bundle.restore.status = "failed";
  const result = validatePreparationBundle(bundle, { allowSyntheticEvidence: true });
  assert.equal(result.status, "valid-evidence");
  assert.equal(result.acceptanceStatus, "failed");
});

test("field mapping, outbound disable, migration and reconciliation fail closed", async (t) => {
  const cases = [
    ["unknown property", (b) => { b.mapping.extra = true; }, "schema_unknown_property"],
    ["raw credential key", (b) => { b.clone.approval.authorization = "opaque"; }, "forbidden_sensitive_key"],
    ["email-like PII", (b) => { b.clone.approval.ownerRef = "person@example.test"; }, "forbidden_sensitive_value"],
    ["PII copied", (b) => { b.mapping.tables[0].fields[1].transformation = "copy"; }, "sensitive_field_not_masked"],
    ["mapping digest drift", (b) => { b.mapping.mappingDigest = fixtureDigest("mapping-drift"); b.migration.mappingDigest = fixtureDigest("mapping-drift"); }, "mapping_manifest_digest_mismatch"],
    ["financial fact dropped", (b) => { const f = b.mapping.tables[0].fields[2]; f.transformation = "drop"; f.targetField = null; }, "immutable_fact_not_preserved"],
    ["outbound control absent", (b) => { b.outboundDisable.channels[0].controls.pop(); }, "outbound_controls_incomplete"],
    ["outbound enabled", (b) => { b.outboundDisable.channels[0].enabled = true; }, "schema_const_invalid"],
    ["backfill count drift", (b) => { b.migration.backfills[0].migratedCount += 1; }, "backfill_count_mismatch"],
    ["rollback order drift", (b) => { b.migration.migrations[0].rollbackOrder = 1; b.migration.migrations[1].rollbackOrder = 2; }, "migration_rollback_not_reverse_order"],
    ["quarantine total drift", (b) => { b.migration.quarantine.total += 1; }, "quarantine_count_mismatch"],
    ["reconciliation count drift", (b) => { b.migration.reconciliation[0].targetCount += 1; }, "reconciliation_count_mismatch"],
    ["reconciliation hash drift", (b) => { b.migration.reconciliation[0].afterDigest = fixtureDigest("reconciliation-drift"); }, "reconciliation_hash_mismatch"],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const bundle = await preparationTemplate();
      mutate(bundle);
      expectCode(() => validatePreparationBundle(bundle), code);
    });
  }
});

test("destruction, provenance and operations evidence fail closed on drift", async (t) => {
  const cases = [
    ["destruction class missing", (b) => { b.destruction.resources.pop(); }, "schema_min_items_invalid"],
    ["artifact chain drift", (b) => { b.provenance.runtime.artifactSha256 = fixtureDigest("artifact-drift"); }, "provenance_artifact_chain_mismatch"],
    ["manifest chain drift", (b) => { b.provenance.runtime.manifestSha256 = fixtureDigest("manifest-drift"); }, "provenance_manifest_chain_mismatch"],
    ["error budget drift", (b) => { b.serviceLevel.errorBudget.remainingMinutes = 1; }, "error_budget_math_invalid"],
    ["restore target drift", (b) => { b.restore.targets.rtoSeconds += 1; }, "restore_targets_mismatch"],
    ["load percentile drift", (b) => { b.load.latencyMs.p50 = 10; b.load.latencyMs.p95 = 5; }, "load_percentile_order_invalid"],
    ["load error-rate drift", (b) => { b.load.errors.count = 1; }, "load_error_math_invalid"],
    ["noisy-neighbor impact drift", (b) => { b.noisyNeighbor.observations[0].impactPercent = 1; }, "noisy_neighbor_impact_math_invalid"],
    ["alert raw payload flag", (b) => { b.alert.payloadRedacted = false; }, "schema_const_invalid"],
    ["cross-contract release drift", (b) => { b.alert.releaseSha = fixtureSha1("release-drift"); }, "release_sha_cross_contract_mismatch"],
    ["cross-contract run drift", (b) => { b.restore.runId = "different-run"; }, "run_id_mismatch"],
    ["execution claim drift", (b) => { b.claimsExecuted = true; }, "claims_execution_mismatch"],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const bundle = await preparationTemplate();
      mutate(bundle);
      expectCode(() => validatePreparationBundle(bundle), code);
    });
  }
});

test("executed chronology and decisions are derived from evidence", async (t) => {
  const cases = [
    ["invalid calendar date", (b) => { b.clone.approval.expiresAt = "2026-02-31T00:00:00.000Z"; b.clone.retention.destroyBy = "2026-02-31T00:00:00.000Z"; }, "schema_timestamp_invalid"],
    ["masking after access", (b) => { b.clone.execution.maskedAt = "2026-08-03T00:04:00.000Z"; }, "clone_timeline_invalid"],
    ["outbound checked before clone creation", (b) => { b.outboundDisable.channels[0].verification.checkedAt = "2026-08-02T23:59:59.000Z"; }, "outbound_verified_before_clone_created"],
    ["outbound checked after access", (b) => { b.outboundDisable.channels[0].verification.checkedAt = "2026-08-03T00:04:00.000Z"; }, "outbound_verified_after_access"],
    ["destruction after retention deadline", (b) => { b.destruction.resources[0].completedAt = "2026-08-10T00:00:01.000Z"; b.destruction.verifiedAt = "2026-08-10T00:00:02.000Z"; b.generatedAt = "2026-08-10T00:00:03.000Z"; }, "destruction_after_deadline"],
    ["restore measured RTO drift", (b) => { b.restore.measured.rtoSeconds += 1; }, "restore_measurement_mismatch"],
    ["load decision drift", (b) => { b.load.status = "failed"; }, "load_status_mismatch"],
    ["capacity decision drift", (b) => { b.noisyNeighbor.capacityDecision.decision = "limit"; }, "capacity_decision_mismatch"],
    ["collateral error-rate threshold breach", (b) => { b.noisyNeighbor.observations[0].errorRateDeltaPercent = 2; }, "capacity_decision_mismatch"],
    ["zero safe concurrency", (b) => { b.noisyNeighbor.capacityDecision.maxSafeConcurrency = 0; }, "capacity_safe_concurrency_invalid"],
    ["alert latency drift", (b) => { b.alert.deliveryLatencyMs += 1; }, "alert_latency_mismatch"],
    ["environment evidence-state drift", (b) => { b.environmentClass = "staging"; b.evidenceState = "verified-current"; }, "environment_evidence_state_mismatch"],
    ["destruction verified early", (b) => { b.destruction.verifiedAt = "2026-08-03T01:59:59.000Z"; }, "destruction_verified_too_early"],
    ["bundle finalized early", (b) => { b.generatedAt = "2026-08-03T02:00:00.000Z"; }, "bundle_generated_before_evidence_complete"],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const bundle = await executedSyntheticEvidence();
      mutate(bundle);
      expectCode(() => validatePreparationBundle(bundle, { allowSyntheticEvidence: true }), code);
    });
  }
});

test("document validator and stable digest are deterministic", async () => {
  const bundle = await preparationTemplate();
  assert.deepEqual(validateEvidenceDocument("mapping", bundle.mapping), {
    schemaVersion: 1,
    schemaName: "mapping",
    status: "valid",
  });
  assert.equal(stableDigest({ b: 2, a: 1 }), stableDigest({ a: 1, b: 2 }));
  const unsafe = structuredClone(bundle.mapping);
  unsafe.tables[0].fields[0].sourceField = "person@example.test";
  expectCode(() => validateEvidenceDocument("mapping", unsafe), "forbidden_sensitive_value");
  const secretLike = structuredClone(bundle.mapping);
  secretLike.tables[0].fields[0].sourceField = "eyJabcdefgh.eyJabcdefgh.abcdefgh";
  expectCode(() => validateEvidenceDocument("mapping", secretLike), "forbidden_sensitive_value");
  const semanticallyUnsafe = structuredClone(bundle.mapping);
  semanticallyUnsafe.tables[0].fields[1].transformation = "copy";
  expectCode(() => validateEvidenceDocument("mapping", semanticallyUnsafe), "sensitive_field_not_masked");
});

test("CLI validates the template and refuses to validate it as executed evidence", async () => {
  const templatePath = fileURLToPath(templateUrl);
  const templateResult = await runCli(["validate-template", templatePath]);
  assert.equal(templateResult.status, "valid-template");
  await assert.rejects(
    runCli(["validate-evidence", templatePath]),
    (error) => error instanceof V4ValidationError && error.code === "bundle_mode_mismatch",
  );
  const schema = await runCli(["schema", "provenance"]);
  assert.equal(schema.properties.contract.const, "newme.v4.release-provenance.v1");
});

test("package is local read-only validation and contains no execution connector", async () => {
  const [cli, validators, example] = await Promise.all([
    read("scripts/v4-rehearsal-kit/cli.mjs"),
    read("scripts/v4-rehearsal-kit/validators.mjs"),
    read("scripts/v4-rehearsal-kit/examples/synthetic-preparation-bundle.json"),
  ]);
  const source = `${cli}\n${validators}`;
  assert.doesNotMatch(source, /node:child_process|\bfetch\s*\(|process\.env|writeFile|appendFile|createWriteStream/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|PGPASSWORD/);
  assert.match(example, /"mode": "template"/);
  assert.match(example, /"claimsExecuted": false/);
  assert.doesNotMatch(example, /"executionStatus": "executed"/);
});
