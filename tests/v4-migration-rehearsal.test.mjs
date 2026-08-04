import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../scripts/v4-rehearsal-kit/cli.mjs";
import {
  assertOutboundKillSwitch,
  prepareMaskedRehearsal,
  tokenizeValue,
  verifyAggregateReconciliation,
} from "../scripts/v4-rehearsal-kit/sam85-tools.mjs";
import {
  V4ValidationError,
  stableDigest,
  validateSam85RehearsalBundle,
} from "../scripts/v4-rehearsal-kit/validators.mjs";

const templateUrl = new URL(
  "../scripts/v4-rehearsal-kit/examples/synthetic-sam85-template.json",
  import.meta.url,
);
const TOKEN_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const digest = (label) => stableDigest({ fixture: label });

async function template() {
  return JSON.parse(await readFile(templateUrl, "utf8"));
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof V4ValidationError && error.code === code);
}

async function executedSyntheticEvidence() {
  const bundle = await template();
  bundle.mode = "evidence";
  bundle.evidenceState = "verified-current";
  bundle.claimsExecuted = true;
  bundle.generatedAt = "2026-08-03T02:02:00.000Z";
  for (const name of ["clone", "mapping", "outboundDisable", "migration", "destruction"]) {
    bundle[name].executionStatus = "executed";
  }
  Object.assign(bundle.clone.sourceSnapshot, {
    snapshotRef: "backup-catalog://sam85/run-20260803/snapshot-019fad6c",
    sha256: digest("snapshot"),
  });
  Object.assign(bundle.clone.approval, {
    status: "approved",
    scopeRef: "approval://change/SAM-85-20260803",
    ownerRef: "iam-role://v4-rehearsal-owner",
    accessRefs: ["iam-role://v4-rehearsal-operator", "iam-role://v4-rehearsal-reviewer"],
    approvedAt: "2026-08-03T00:00:00.000Z",
  });
  Object.assign(bundle.clone.execution, {
    createdAt: "2026-08-03T00:01:00.000Z",
    maskedAt: "2026-08-03T00:02:00.000Z",
    applicationAccessEnabledAt: "2026-08-03T00:03:00.000Z",
  });
  bundle.outboundDisable.channels.forEach((entry, index) => {
    Object.assign(entry.verification, {
      status: "blocked",
      checkedAt: "2026-08-03T00:02:30.000Z",
      evidenceDigest: digest(`outbound-${index}`),
    });
  });
  bundle.migration.releaseSha = digest("release").slice(0, 40);
  bundle.migration.migrations.forEach((entry, index) => {
    entry.forwardSha256 = digest(`forward-${index}`);
    entry.rollbackSha256 = digest(`rollback-${index}`);
    entry.applyStatus = "passed";
    entry.rollbackStatus = "passed";
  });
  bundle.migration.backfills.forEach((entry) => { entry.status = "passed"; });
  bundle.migration.quarantine.aggregateDigest = digest("quarantine");
  bundle.migration.reconciliation.forEach((entry, index) => {
    entry.beforeDigest = digest(`reconcile-${index}`);
    entry.afterDigest = entry.beforeDigest;
    entry.status = "passed";
  });
  bundle.destruction.resources.forEach((entry, index) => {
    entry.status = ["credentials", "access"].includes(entry.kind) ? "revoked" : "destroyed";
    entry.completedAt = "2026-08-03T02:00:00.000Z";
    entry.evidenceDigest = digest(`destroy-${index}`);
  });
  bundle.destruction.verifiedByRef = "iam-role://independent-reviewer";
  bundle.destruction.verifiedAt = "2026-08-03T02:01:00.000Z";
  return bundle;
}

test("SAM-85 template and CLI are fail-closed and never claim execution", async () => {
  const bundle = await template();
  const result = validateSam85RehearsalBundle(bundle, { expectedMode: "template" });
  assert.deepEqual(result.linearIds, ["SAM-85"]);
  assert.equal(result.acceptanceStatus, "not_executed");
  assert.equal(result.claimsExecuted, false);
  assert.equal(
    (await runCli(["validate-sam85-template", fileURLToPath(templateUrl)])).status,
    "valid-template",
  );
  await assert.rejects(
    runCli(["validate-sam85-evidence", fileURLToPath(templateUrl)]),
    (error) => error instanceof V4ValidationError && error.code === "bundle_mode_mismatch",
  );
});

test("offline masking tokenizes identifiers, preserves financial semantics and reconciles counts", async () => {
  const bundle = await template();
  const sourceByTable = {
    legacy_leads: [
      { id: "lead-001", email: "alpha@synthetic.invalid", amount: 100 },
      { id: "lead-002", email: "beta@synthetic.invalid", amount: 250 },
      { id: "lead-003", amount: 300 },
    ],
  };
  const original = structuredClone(sourceByTable);
  const result = prepareMaskedRehearsal({ bundle, sourceByTable, tokenKey: TOKEN_KEY, environment: {} });
  assert.deepEqual(sourceByTable, original);
  assert.equal(result.targets.leads.length, 2);
  assert.equal(result.aggregateEvidence.tables[0].sourceCount, 3);
  assert.equal(result.aggregateEvidence.tables[0].migratedCount, 2);
  assert.equal(result.aggregateEvidence.tables[0].quarantinedCount, 1);
  assert.equal(result.targets.leads[0].amount + result.targets.leads[1].amount, 350);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /lead-00[123]|alpha@|beta@/);
  assert.match(serialized, /tok_[0-9a-f]{32}/);
  assert.deepEqual(verifyAggregateReconciliation(result), {
    contract: "newme.v4.sam85-offline-masking-result.v1",
    runId: bundle.runId,
    status: "reconciled",
    tableCount: 1,
    quarantinedCount: 1,
  });
});

test("tokenization is deterministic, namespace-bound and key-gated", () => {
  assert.equal(tokenizeValue("lead-001", TOKEN_KEY, "leads.id"), tokenizeValue("lead-001", TOKEN_KEY, "leads.id"));
  assert.notEqual(tokenizeValue("lead-001", TOKEN_KEY, "leads.id"), tokenizeValue("lead-001", TOKEN_KEY, "users.id"));
  expectCode(() => tokenizeValue("lead-001", "short", "leads.id"), "token_key_too_short");
});

test("outbound kill switch refuses configured delivery or payment credentials", () => {
  const result = assertOutboundKillSwitch({});
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.channels, ["email", "messaging", "webhook", "portal", "payment"]);
  for (const key of [
    "SMTP_URL",
    "RESEND_API_KEY",
    "WHATSAPP_ACCESS_TOKEN",
    "META_CAPI_ACCESS_TOKEN",
    "WEBHOOK_URL",
    "SENTRY_SERVICE_HOOK_SECRET",
    "PORTAL_API_KEY",
    "STRIPE_SECRET_KEY",
    "PAYPAL_CLIENT_SECRET",
  ]) {
    expectCode(() => assertOutboundKillSwitch({ [key]: "configured-for-test" }), "outbound_environment_present");
  }
});

test("masking refuses table drift and prototype-bearing records", async () => {
  const bundle = await template();
  expectCode(() => prepareMaskedRehearsal({
    bundle,
    sourceByTable: { legacy_leads: [], unexpected: [] },
    tokenKey: TOKEN_KEY,
    environment: {},
  }), "source_table_set_invalid");
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"id":"lead-001","email":"x@synthetic.invalid","amount":1}');
  const result = prepareMaskedRehearsal({
    bundle,
    sourceByTable: { legacy_leads: [hostile] },
    tokenKey: TOKEN_KEY,
    environment: {},
  });
  assert.equal(result.targets.leads.length, 0);
  assert.equal(result.quarantineLedger[0].reasonCode, "source_record_prototype_key");
  assert.equal(Object.prototype.polluted, undefined);
});

test("executed UAT contract requires isolated evidence and complete destruction", async () => {
  const bundle = await executedSyntheticEvidence();
  expectCode(() => validateSam85RehearsalBundle(bundle, { expectedMode: "evidence" }), "synthetic_execution_not_evidence");
  assert.equal(validateSam85RehearsalBundle(bundle, {
    expectedMode: "evidence",
    allowSyntheticEvidence: true,
  }).acceptanceStatus, "passed");

  const shared = structuredClone(bundle);
  shared.clone.networkBoundary.sharedStaging = true;
  expectCode(() => validateSam85RehearsalBundle(shared, { allowSyntheticEvidence: true }), "schema_const_invalid");

  const incomplete = structuredClone(bundle);
  incomplete.destruction.resources[0].status = "pending";
  expectCode(() => validateSam85RehearsalBundle(incomplete, { allowSyntheticEvidence: true }), "destruction_proof_incomplete");
});

test("SAM-85 package has no database, network or secret connector", async () => {
  const source = await readFile(new URL("../scripts/v4-rehearsal-kit/sam85-tools.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bfetch\s*\(|https?:\/\/|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|PGPASSWORD/);
  assert.match(source, /claimsCloneExecuted: false/);
});
