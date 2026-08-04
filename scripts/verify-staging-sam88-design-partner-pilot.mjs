#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^(?!([0-9a-f])\1{63}$)[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE = /^role:[a-z][a-z0-9_-]{2,63}$/;
const DECISION = /^DP-[A-Z0-9-]{8,64}$/;
const REFERENCE = /^(?:linear|ticket|vault|s3-redacted):\/\/[A-Za-z0-9._/-]{8,240}$/;
const ALIAS = /^org-[a-z0-9-]{4,80}$/;
const PLAN = /^[a-z][a-z0-9_-]{1,63}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PHASES = [
  "provisioning",
  "paid_seat_entitlement",
  "vertical_e2e",
  "tenant_isolation",
  "bounded_support_audit",
  "billing_lifecycle_export",
  "backup_restore_exit",
];
const VERTICALS = ["real_estate", "retail"];
const ASSERTIONS = {
  real_estate: {
    provisioning: "organization_and_membership_provisioned",
    paid_seat_entitlement: "paid_seat_limit_and_entitlement_verified",
    vertical_e2e: "listing_to_lead_to_contract_verified",
    tenant_isolation: "cross_organization_access_denied",
    bounded_support_audit: "support_session_bounded_and_audited",
    billing_lifecycle_export: "billing_lifecycle_and_authorized_export_verified",
    backup_restore_exit: "backup_restore_and_exit_evidence_verified",
  },
  retail: {
    provisioning: "organization_and_membership_provisioned",
    paid_seat_entitlement: "paid_seat_limit_and_entitlement_verified",
    vertical_e2e: "catalog_to_order_to_fulfillment_verified",
    tenant_isolation: "cross_organization_access_denied",
    bounded_support_audit: "support_session_bounded_and_audited",
    billing_lifecycle_export: "billing_lifecycle_and_authorized_export_verified",
    backup_restore_exit: "backup_restore_and_exit_evidence_verified",
  },
};

export class Sam88PilotError extends Error {
  constructor(code) {
    super(code);
    this.name = "Sam88PilotError";
    this.code = code;
  }
}

function fail(code) {
  throw new Sam88PilotError(code);
}

function exactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function requireText(value, code, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function requireUtc(value, code) {
  requireText(value, code, ISO_UTC);
  if (Number.isNaN(Date.parse(value))) fail(code);
  return value;
}

function noSensitiveText(value, code) {
  const text = JSON.stringify(value);
  if (/(?:bearer\s+|basic\s+|-----BEGIN|eyJ[a-zA-Z0-9_-]{10,}\.|@|\+\d{6,})/i.test(text)) fail(code);
}

function validateReference(value, code) {
  if (!exactKeys(value, ["reference", "sha256"])) fail(`${code}_shape`);
  const reference = requireText(value.reference, `${code}_reference`, REFERENCE);
  const sha256 = requireText(value.sha256, `${code}_digest`, SHA256);
  return { reference, sha256 };
}

function validateEvidence(value, vertical, phase, releaseSha) {
  if (!exactKeys(value, ["record", "reference", "sha256"])) fail(`evidence_${vertical}_${phase}_shape`);
  const ref = validateReference(
    { reference: value.reference, sha256: value.sha256 },
    `evidence_${vertical}_${phase}`,
  );
  if (!exactKeys(value.record, ["assertion", "observedAt", "redacted", "releaseSha", "status"])) {
    fail(`evidence_${vertical}_${phase}_record_shape`);
  }
  if (
    value.record.status !== "verified"
    || value.record.redacted !== true
    || value.record.releaseSha !== releaseSha
    || value.record.assertion !== ASSERTIONS[vertical][phase]
  ) fail(`evidence_${vertical}_${phase}_record_invalid`);
  requireUtc(value.record.observedAt, `evidence_${vertical}_${phase}_observed_at`);
  noSensitiveText(value, `evidence_${vertical}_${phase}_contains_sensitive_text`);
  return { phase, ...ref, observedAt: value.record.observedAt };
}

function validatePartner(value, releaseSha) {
  if (!exactKeys(value, ["approval", "evidence", "organization", "paidSeat", "vertical"])) {
    fail("partner_shape_invalid");
  }
  if (!VERTICALS.includes(value.vertical)) fail("partner_vertical_invalid");
  const vertical = value.vertical;
  if (!exactKeys(value.organization, ["alias", "organizationId"])) fail(`organization_${vertical}_shape`);
  const organizationId = requireText(value.organization.organizationId, `organization_${vertical}_id`, UUID);
  const alias = requireText(value.organization.alias, `organization_${vertical}_alias`, ALIAS);
  if (!exactKeys(value.approval, ["approvalEvidence", "approvedAt", "approvedBy", "decisionId"])) {
    fail(`approval_${vertical}_shape`);
  }
  const decisionId = requireText(value.approval.decisionId, `approval_${vertical}_decision`, DECISION);
  const approvedBy = requireText(value.approval.approvedBy, `approval_${vertical}_approver`, ROLE);
  const approvedAt = requireUtc(value.approval.approvedAt, `approval_${vertical}_approved_at`);
  const approvalEvidence = validateReference(value.approval.approvalEvidence, `approval_${vertical}_evidence`);
  if (!exactKeys(value.paidSeat, ["planKey", "purchasedSeats", "seatEvidence"])) fail(`seat_${vertical}_shape`);
  const planKey = requireText(value.paidSeat.planKey, `seat_${vertical}_plan`, PLAN);
  if (!Number.isSafeInteger(value.paidSeat.purchasedSeats) || value.paidSeat.purchasedSeats < 1 || value.paidSeat.purchasedSeats > 10000) {
    fail(`seat_${vertical}_count`);
  }
  const seatEvidence = validateReference(value.paidSeat.seatEvidence, `seat_${vertical}_evidence`);
  if (!exactKeys(value.evidence, PHASES)) fail(`evidence_${vertical}_phase_set`);
  const evidence = PHASES.map((phase) => validateEvidence(value.evidence[phase], vertical, phase, releaseSha));
  noSensitiveText(value, `partner_${vertical}_contains_sensitive_text`);
  return {
    vertical,
    organization: { organizationId, alias },
    approval: { decisionId, approvedBy, approvedAt, approvalEvidence },
    paidSeat: { planKey, purchasedSeats: value.paidSeat.purchasedSeats, seatEvidence },
    evidence,
  };
}

/**
 * Parses a redacted evidence packet. It intentionally does not provision a
 * partner, read credentials, or claim that the pilot was executed.
 */
export function validateSam88PilotManifest(body, expectedReleaseSha) {
  if (!SHA.test(expectedReleaseSha ?? "")) fail("expected_release_sha_invalid");
  if (!exactKeys(body, ["cohort", "execution", "linearId", "releaseSha", "schemaVersion", "target"])) {
    fail("manifest_shape_invalid");
  }
  if (body.schemaVersion !== 1 || body.linearId !== "SAM-88" || body.target !== "staging-only") {
    fail("manifest_identity_invalid");
  }
  if (body.releaseSha !== expectedReleaseSha) fail("release_sha_mismatch");
  if (!exactKeys(body.execution, ["redaction", "status", "submittedAt"])) fail("execution_shape_invalid");
  if (body.execution.status !== "not-executed" || body.execution.redaction !== "references-and-digests-only") {
    fail("execution_must_not_claim_pilot_completed");
  }
  requireUtc(body.execution.submittedAt, "execution_submitted_at_invalid");
  if (!Array.isArray(body.cohort) || body.cohort.length !== VERTICALS.length) fail("cohort_count_invalid");
  const cohort = body.cohort.map((partner) => validatePartner(partner, expectedReleaseSha));
  if (new Set(cohort.map((partner) => partner.vertical)).size !== VERTICALS.length) fail("cohort_verticals_invalid");
  if (new Set(cohort.map((partner) => partner.organization.organizationId)).size !== VERTICALS.length) fail("cohort_organization_ids_must_differ");
  if (new Set(cohort.map((partner) => partner.organization.alias)).size !== VERTICALS.length) fail("cohort_aliases_must_differ");
  if (new Set(cohort.map((partner) => partner.approval.decisionId)).size !== VERTICALS.length) fail("cohort_decisions_must_differ");
  noSensitiveText(body, "manifest_contains_sensitive_text");
  return {
    schemaVersion: 1,
    linearId: "SAM-88",
    target: "staging-only",
    releaseSha: expectedReleaseSha,
    execution: { status: "not-executed", redaction: "references-and-digests-only" },
    readiness: "authorized_cohort_evidence_submitted",
    cohort,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.length !== 6 || process.argv[2] !== "--manifest" || process.argv[4] !== "--expected-release") {
    console.error("SAM-88 pilot readiness failed: usage --manifest <path> --expected-release <sha>");
    process.exitCode = 64;
  } else {
    const manifestPath = process.argv[3];
    const expectedReleaseSha = process.argv[5];
    if (!SHA.test(expectedReleaseSha ?? "")) {
      console.error("SAM-88 pilot readiness failed: usage --manifest <path> --expected-release <sha>");
      process.exitCode = 64;
    } else {
      try {
        const body = JSON.parse(await readFile(manifestPath, "utf8"));
        process.stdout.write(`${JSON.stringify(validateSam88PilotManifest(body, expectedReleaseSha))}\n`);
      } catch (error) {
        const code = error instanceof Sam88PilotError ? error.code : "invalid_manifest_json";
        console.error(`SAM-88 pilot readiness failed: ${code}`);
        process.exitCode = 1;
      }
    }
  }
}
