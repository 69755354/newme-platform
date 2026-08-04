import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../scripts/v4-rehearsal-kit/cli.mjs";
import { stableDigest, V4ValidationError, validateSam85ExecutionPreflight } from "../scripts/v4-rehearsal-kit/validators.mjs";

const digest = (value) => stableDigest({ sam85PreflightFixture: value });
const sha = (value) => digest(value).slice(0, 40);

function approvedPreflight() {
  return {
    contract: "newme.v4.sam85-execution-preflight.v1",
    schemaVersion: 1,
    runId: "sam85-isolated-run-20260805",
    generatedAt: "2026-08-05T00:00:00.000Z",
    linearId: "SAM-85",
    claimsExecuted: false,
    environmentClass: "isolated-ephemeral-clone",
    approval: {
      status: "approved",
      purposeCode: "v4-migration-rehearsal",
      approvalRef: "approval://sam85/20260805",
      ownerRef: "iam-role://v4-owner",
      operatorRef: "iam-role://v4-operator",
      reviewerRef: "iam-role://v4-reviewer",
      approvedAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-05T06:00:00.000Z",
    },
    source: {
      snapshotRef: "backup-catalog://newme/sam85/20260805",
      sha256: digest("encrypted-authoritative-source"),
      encrypted: true,
      authoritative: true,
    },
    release: { gitSha: sha("release"), treeSha: sha("tree") },
    isolation: {
      sharedStaging: false,
      productionWriteRoute: false,
      cloneOnlyCredentials: true,
      productionCredentialsDenied: true,
      applicationAccessEnabled: false,
    },
    masking: { mappingDigest: digest("mapping"), tokenKeyRef: "vault-ref://sam85/token-key", rawOutsideClone: false },
    outbound: ["email", "messaging", "webhook", "portal", "payment"].map((channel) => ({
      channel,
      configurationDenyPlanned: true,
      networkDenyPlanned: true,
      runtimeDenyPlanned: true,
    })),
    migrations: [
      { migrationId: "20260805010000_sam85_first", forwardSha256: digest("forward-one"), rollbackSha256: digest("rollback-one"), applyOrder: 1, rollbackOrder: 2 },
      { migrationId: "20260805020000_sam85_second", forwardSha256: digest("forward-two"), rollbackSha256: digest("rollback-two"), applyOrder: 2, rollbackOrder: 1 },
    ],
    destruction: {
      destroyBy: "2026-08-05T06:00:00.000Z",
      resources: ["database", "storage", "credentials", "logs", "exports", "access"].map((kind) => ({ kind, resourceRef: `destroy://sam85/${kind}` })),
    },
  };
}

function expectCode(mutator, code) {
  const candidate = approvedPreflight();
  mutator(candidate);
  assert.throws(() => validateSam85ExecutionPreflight(candidate), (error) => error instanceof V4ValidationError && error.code === code);
}

test("approved preflight authorizes the next external step without claiming execution", () => {
  const result = validateSam85ExecutionPreflight(approvedPreflight());
  assert.deepEqual(result, {
    contract: "newme.v4.sam85-execution-preflight.v1",
    schemaVersion: 1,
    status: "authorized-preflight",
    claimsExecuted: false,
    runId: "sam85-isolated-run-20260805",
    linearId: "SAM-85",
  });
});

test("preflight fails closed on isolation, outbound, approval, destruction and asset drift", async (t) => {
  const cases = [
    ["shared staging", (value) => { value.isolation.sharedStaging = true; }, "schema_const_invalid"],
    ["production route", (value) => { value.isolation.productionWriteRoute = true; }, "schema_const_invalid"],
    ["application access", (value) => { value.isolation.applicationAccessEnabled = true; }, "schema_const_invalid"],
    ["outbound omission", (value) => { value.outbound.pop(); }, "schema_min_items_invalid"],
    ["approval expiry drift", (value) => { value.approval.expiresAt = "2026-08-05T05:59:59.000Z"; }, "preflight_approval_window_invalid"],
    ["destroy deadline drift", (value) => { value.destruction.destroyBy = "2026-08-05T06:00:01.000Z"; }, "preflight_approval_window_invalid"],
    ["forward reverse drift", (value) => { value.migrations[0].rollbackOrder = 1; }, "preflight_migration_rollback_order_invalid"],
    ["placeholder source", (value) => { value.source.snapshotRef = "snapshot-placeholder"; }, "evidence_placeholder_reference"],
    ["sensitive content", (value) => { value.approval.ownerRef = "Bearer secret-should-never-pass"; }, "forbidden_sensitive_value"],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, () => expectCode(mutate, code));
  }
});

test("CLI validates only a regular non-secret preflight JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sam85-preflight-"));
  const path = join(directory, "approved.json");
  try {
    await writeFile(path, JSON.stringify(approvedPreflight()), { mode: 0o600 });
    const result = await runCli(["validate-sam85-preflight", path]);
    assert.equal(result.status, "authorized-preflight");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
