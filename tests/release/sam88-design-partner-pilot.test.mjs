import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateSam88PilotManifest, Sam88PilotError } from "../../scripts/verify-staging-sam88-design-partner-pilot.mjs";

const sha = "a".repeat(40);
const digest = (seed) => {
  const first = /^[0-9a-f]$/i.test(seed[0] ?? "") ? seed[0].toLowerCase() : "a";
  return `${first.repeat(63)}${first === "a" ? "b" : "a"}`;
};
const phases = [
  "provisioning", "paid_seat_entitlement", "vertical_e2e", "tenant_isolation",
  "bounded_support_audit", "billing_lifecycle_export", "backup_restore_exit",
];
const assertions = {
  real_estate: [
    "organization_and_membership_provisioned", "paid_seat_limit_and_entitlement_verified",
    "listing_to_lead_to_contract_verified", "cross_organization_access_denied",
    "support_session_bounded_and_audited", "billing_lifecycle_and_authorized_export_verified",
    "backup_restore_and_exit_evidence_verified",
  ],
  retail: [
    "organization_and_membership_provisioned", "paid_seat_limit_and_entitlement_verified",
    "catalog_to_order_to_fulfillment_verified", "cross_organization_access_denied",
    "support_session_bounded_and_audited", "billing_lifecycle_and_authorized_export_verified",
    "backup_restore_and_exit_evidence_verified",
  ],
};

function ref(seed) {
  return { reference: `vault://sam88-redacted/${seed}-evidence`, sha256: digest(seed) };
}

function partner(vertical, id, seed) {
  const evidence = Object.fromEntries(phases.map((phase, index) => [phase, {
    ...ref(`${seed}-${phase}`),
    record: {
      assertion: assertions[vertical][index], observedAt: "2026-08-05T12:00:00Z",
      redacted: true, releaseSha: sha, status: "verified",
    },
  }]));
  return {
    vertical,
    organization: { organizationId: id, alias: `org-${vertical.replace("_", "-")}-partner` },
    approval: {
      decisionId: `DP-${seed.toUpperCase()}-APPROVED`, approvedBy: "role:commercial-owner",
      approvedAt: "2026-08-05T11:00:00Z", approvalEvidence: ref(`${seed}-approval`),
    },
    paidSeat: { planKey: "growth", purchasedSeats: 5, seatEvidence: ref(`${seed}-seats`) },
    evidence,
  };
}

function manifest() {
  return {
    schemaVersion: 1, linearId: "SAM-88", target: "staging-only", releaseSha: sha,
    execution: { status: "not-executed", redaction: "references-and-digests-only", submittedAt: "2026-08-05T12:30:00Z" },
    cohort: [
      partner("real_estate", "11111111-1111-4111-8111-111111111111", "realestate"),
      partner("retail", "22222222-2222-4222-8222-222222222222", "retail"),
    ],
  };
}

test("SAM-88 accepts only redacted, explicitly approved real-estate and retail evidence", () => {
  const result = validateSam88PilotManifest(manifest(), sha);
  assert.equal(result.execution.status, "not-executed");
  assert.equal(result.readiness, "authorized_cohort_evidence_submitted");
  assert.deepEqual(result.cohort.map((item) => item.vertical).sort(), ["real_estate", "retail"]);
  assert.equal(result.cohort[0].evidence.length, 7);
});

test("SAM-88 fails closed for authorization, proof, release, and sensitive-data drift", () => {
  for (const mutate of [
    (body) => { delete body.cohort[0].approval.approvalEvidence; },
    (body) => { body.execution.status = "executed"; },
    (body) => { body.cohort.pop(); },
    (body) => { body.cohort[0].evidence.vertical_e2e.record.assertion = "anything"; },
    (body) => { body.cohort[0].evidence.backup_restore_exit.record.redacted = false; },
    (body) => { body.cohort[0].organization.alias = "partner@example.com"; },
    (body) => { body.releaseSha = "b".repeat(40); },
  ]) {
    const body = manifest();
    mutate(body);
    assert.throws(() => validateSam88PilotManifest(body, sha), Sam88PilotError);
  }
});

test("SAM-88 controller remains staging-only, root-owned, and does not print the manifest", async () => {
  const control = await readFile(new URL("../../scripts/newme-staging-control.sh", import.meta.url), "utf8");
  for (const pattern of [
    /SAM88_MANIFEST="\$STATE_DIR\/sam88-design-partner-pilot-manifest\.json"/,
    /SAM88_EVIDENCE="\$STATE_DIR\/last-validate-sam88-pilot\.json"/,
    /validate-sam88-pilot\) run_sam88_pilot_readiness/,
    /verify_current_release "\$SHA"/,
    /\[ "\$\(stat -c '%u:%g:%a' "\$SAM88_MANIFEST"\)" = "0:0:600" \]/,
    /copy_commit_blob "\$SHA" "\$SAM88_RUNNER" "\$runner"/,
    /\/usr\/bin\/node "\$runner" --manifest "\$SAM88_MANIFEST" --expected-release "\$SHA"/,
    /body\?\.linearId !== "SAM-88"/,
    /body\?\.execution\?\.status !== "not-executed"/,
    /body\?\.readiness !== "authorized_cohort_evidence_submitted"/,
    /install -m 0600 -o root -g root "\$output" "\$evidence_tmp"/,
  ]) assert.match(control, pattern);
  assert.doesNotMatch(control, /validate-sam88-pilot[\s\S]*?(?:NEWME_PRODUCTION|\/opt\/newme\/current|cat "\$SAM88_MANIFEST")/);
});
