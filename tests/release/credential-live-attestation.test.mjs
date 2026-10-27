import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLAIM_VERSION,
  COMPLETION_VERSION,
  CredentialLiveError,
  PRECHECK_VERSION,
  PROVIDER_IDENTITY_RECEIPT_VERSION,
  PROTECTED_CONTROL_PLANE_ASSETS,
  READBACK_VERSION,
  REVOCATION_PROOF_VERSION,
  TOMBSTONE_VERSION,
  canonicalCredentialJsonBytes,
  collectSupabaseEvidence,
  credentialEndpointContractSha256,
  credentialFingerprint,
  githubNextLink,
  policySha256,
  providerIdentityEndpointContractSha256,
  sha256,
  signCredentialEvidence,
  transitionCredentialLiveState,
  validateCompletion,
  validateCredentialClaim,
  validateCredentialLivePolicy,
  validateGithubEvidence,
  validateInstalledProtectionMarker,
  validatePrecheck,
  validateProviderIdentityReceipt,
  validateReleaseRelation,
  validateReadback,
  validateRevocationProof,
  validateSandwich,
  validateSupabaseEvidence,
  validateTombstone,
} from "../../scripts/credential-live-attestation.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const POLICY_FILE = path.join(ROOT, "infra", "release", "credential-live-attestation-policy-v1.json");
const NOW = Date.parse("2026-08-15T04:30:00Z");
const now = (offsetSeconds = 0) => new Date(NOW + offsetSeconds * 1000).toISOString().replace(".000Z", "Z");
const providerDate = (offsetSeconds = 0) => new Date(NOW + offsetSeconds * 1000).toUTCString();
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const RUN = "123456";
const ATTEMPT = 2;
const TX = "123e4567-e89b-42d3-a456-426614174000";
const NONCE = randomBytes(32).toString("base64url");
const PROTECTED_ASSETS_SHA256 = sha256("candidate-protected-assets-marker");
const PRE_CUTOVER_INVOCATION_ID = "service-invocation-before";
const POST_CUTOVER_INVOCATION_ID = "service-invocation-after";

const keys = generateKeyPairSync("ed25519");
const privateKeyBytes = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyBytes = keys.publicKey.export({ type: "spki", format: "pem" });
const fingerprintKey = randomBytes(32);
const SYNTHETIC_SECRETS = Object.freeze(Object.fromEntries(
  ["old_pat", "management_reader", "old_service", "replacement_service"].map((kind) => [
    kind,
    `synthetic-${kind}-credential-value-never-persisted`,
  ]),
));
const secretLeakGuard = Object.freeze(Object.fromEntries(
  Object.entries(SYNTHETIC_SECRETS).map(([kind, value]) => [kind, Buffer.from(value)]),
));

function measuredRelation({ remediationSha = SHA_A, releaseSha = SHA_B } = {}) {
  return {
    remediation_sha: remediationSha,
    release_sha: releaseSha,
    commit_count: 1,
    direct_parent: remediationSha,
    changed_paths: ["TASKBOARD.md"],
    per_commit_changed_paths: [["TASKBOARD.md"]],
  };
}

function policyFixture() {
  const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
  policy.receipts.public_key_file_sha256 = sha256(publicKeyBytes);
  policy.receipts.public_key_spki_sha256 = sha256(keys.publicKey.export({ type: "spki", format: "der" }));
  policy.credential_identities = {
    old_pat: { provider_object_id: "pat-old-1", scope_id: "account-owner", provider_kind: "pat" },
    management_reader: { provider_object_id: "pat-reader-2", scope_id: `project-${policy.project_ref}`, provider_kind: "pat" },
    old_service: { provider_object_id: "service-old-1", scope_id: `project-${policy.project_ref}`, provider_kind: "secret" },
    replacement_service: { provider_object_id: "service-new-2", scope_id: `project-${policy.project_ref}`, provider_kind: "secret" },
  };
  return policy;
}

function fingerprints(policy) {
  const result = {};
  for (const kind of ["old_pat", "management_reader", "old_service", "replacement_service"]) {
    result[kind] = credentialFingerprint({
      keyBytes: fingerprintKey,
      keyId: policy.fingerprints.key_id,
      transactionId: TX,
      nonce: NONCE,
      kind,
      secretBytes: Buffer.from(SYNTHETIC_SECRETS[kind]),
    });
  }
  return result;
}

function identitySet(policy) {
  const fp = fingerprints(policy);
  return {
    old_pat: { kind: "old_pat", fingerprint: fp.old_pat, provider_object_id: "pat-old-1", scope_id: "account-owner" },
    management_reader: { kind: "management_reader", fingerprint: fp.management_reader, provider_object_id: "pat-reader-2", scope_id: "project-vfopmpxlhwzpxqegayew" },
    old_service: { kind: "old_service", fingerprint: fp.old_service, provider_object_id: "service-old-1", scope_id: "project-vfopmpxlhwzpxqegayew" },
    replacement_service: { kind: "replacement_service", fingerprint: fp.replacement_service, provider_object_id: "service-new-2", scope_id: "project-vfopmpxlhwzpxqegayew" },
  };
}

function ci(sha = SHA_A) {
  return {
    workflow_id: 310914082,
    workflow_path: ".github/workflows/ci.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    run_id: RUN,
    run_attempt: ATTEMPT,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    completed_at: now(-120),
    verified_at: now(-60),
    requests: [
      {
        operation: "run",
        status: 200,
        observed_at: now(-61),
        provider_date: providerDate(-61),
        request_id: "ci-run-request-1",
      },
      {
        operation: "workflow",
        status: 200,
        observed_at: now(-60),
        provider_date: providerDate(-60),
        request_id: "ci-workflow-request-2",
      },
    ],
  };
}

function github(state = "open", observedOffset = -20) {
  const resolved = state === "resolved";
  const operations = [
    "alert-1",
    "alert-2",
    "open-page-1",
  ];
  return {
    repository: "69755354/newme-platform",
    api_version: "2026-03-10",
    hide_secret: true,
    pages_read: 1,
    pagination_complete: true,
    open_count: resolved ? 0 : 2,
    alerts: [
      {
        number: 1,
        secret_type: "supabase_personal_access_token",
        state,
        resolution: resolved ? "revoked" : null,
        resolved_at: resolved ? now(observedOffset - 1) : null,
        publicly_leaked: true,
      },
      {
        number: 2,
        secret_type: "supabase_secret_key",
        state,
        resolution: resolved ? "revoked" : null,
        resolved_at: resolved ? now(observedOffset - 1) : null,
        publicly_leaked: true,
      },
    ],
    requests: operations.map((operation, index) => ({
      operation,
      status: 200,
      observed_at: now(observedOffset),
      provider_date: providerDate(observedOffset),
      request_id: `github-${operation}-${index}`,
      link_sha256: sha256(""),
    })),
    observed_at: now(observedOffset),
    provider_date: providerDate(observedOffset),
    request_id: "github-request-1",
  };
}

function supabase(stage = "precheck", observedOffset = -20) {
  return {
    project_ref: "vfopmpxlhwzpxqegayew",
    reveal: false,
    pagination_complete: true,
    pages_read: 1,
    old_service: {
      provider_object_id: "service-old-1",
      kind: "secret",
      scope_id: "project-vfopmpxlhwzpxqegayew",
      present: stage === "precheck",
      policy_identity_match: stage === "precheck",
    },
    replacement_service: {
      provider_object_id: "service-new-2",
      kind: "secret",
      scope_id: "project-vfopmpxlhwzpxqegayew",
      present: true,
      policy_identity_match: true,
    },
    observed_at: now(observedOffset),
    provider_date: providerDate(observedOffset),
    request_id: "supabase-request-1",
  };
}

function consumerEvidenceDigest(consumer) {
  const { evidence_sha256: _ignored, ...projection } = consumer;
  return sha256(canonicalCredentialJsonBytes(projection));
}

function consumers(
  policy,
  transitionLastSha256,
  replacementFingerprint,
  invocationId = POST_CUTOVER_INVOCATION_ID,
  observedBase = -15,
  protectedAssetsSha256 = PROTECTED_ASSETS_SHA256,
) {
  return [
    ["service_role_auth_admin_read", "supabase_service_role_read", "/auth/v1/admin/users?page=1&per_page=1"],
    ["application_readiness", "root_command", "/usr/local/libexec/newme/newme-readiness.sh"],
    ["dependency_probe", "root_command", "/opt/hermes-scripts/observability/dependency-probe.sh"],
  ].map(([id, kind, consumerPath], index) => {
    const consumer = {
      id,
      kind,
      path: consumerPath,
      status: "pass",
      transition_last_sha256: transitionLastSha256,
      invocation_id: invocationId,
      replacement_fingerprint: replacementFingerprint,
      protected_assets_sha256: protectedAssetsSha256,
      contract_sha256: sha256(canonicalCredentialJsonBytes({
        id,
        kind,
        path: consumerPath,
        replacement_fingerprint_required: true,
      })),
      observed_at: now(observedBase + index),
    };
    return {
      ...consumer,
      evidence_sha256: consumerEvidenceDigest(consumer),
    };
  });
}

function sandwich(policy, kind, oldFingerprint, replacementFingerprint, startedOffset = -12, finishedOffset = -10) {
  return {
    kind,
    endpoint_contract_sha256: credentialEndpointContractSha256(policy, kind),
    old_fingerprint: oldFingerprint,
    replacement_fingerprint: replacementFingerprint,
    steps: [
      {
        credential: ["replacement", "before"].join("_"), status: 200, provider_code: "success",
        request_id: `${kind}-new-before`, observed_at: now(startedOffset), provider_date: providerDate(startedOffset),
      },
      {
        credential: "old", status: 401,
        provider_code: kind === "service" ? "unregistered_api_key" : "unauthorized",
        request_id: `${kind}-old`, observed_at: now((startedOffset + finishedOffset) / 2),
        provider_date: providerDate((startedOffset + finishedOffset) / 2),
      },
      {
        credential: ["replacement", "after"].join("_"), status: 200, provider_code: "success",
        request_id: `${kind}-new-after`, observed_at: now(finishedOffset), provider_date: providerDate(finishedOffset),
      },
    ],
    started_at: now(startedOffset),
    finished_at: now(finishedOffset),
  };
}

function claim(policy) {
  return {
    version: CLAIM_VERSION,
    transaction_id: TX,
    nonce: NONCE,
    candidate_sha: SHA_A,
    ci_run_id: RUN,
    ci_run_attempt: ATTEMPT,
    created_at: now(-40),
    expires_at: now(700),
    credentials: identitySet(policy),
  };
}

function signedProviderIdentityReceipt(policy, liveClaim = claim(policy)) {
  return signCredentialEvidence({
    document: {
      version: PROVIDER_IDENTITY_RECEIPT_VERSION,
      purpose: "provider_identity",
      policy_sha256: policySha256(policy),
      claim_sha256: sha256(canonicalCredentialJsonBytes(liveClaim)),
      candidate_sha: liveClaim.candidate_sha,
      transaction_id: liveClaim.transaction_id,
      nonce: liveClaim.nonce,
      credentials: structuredClone(liveClaim.credentials),
      provider_binding: {
        operation: "get-exact-api-key-reveal",
        endpoint_contract_sha256: providerIdentityEndpointContractSha256(
          policy,
          liveClaim.credentials.replacement_service.provider_object_id,
        ),
        project_ref: policy.project_ref,
        provider_object_id: liveClaim.credentials.replacement_service.provider_object_id,
        provider_kind: policy.credential_identities.replacement_service.provider_kind,
        scope_id: liveClaim.credentials.replacement_service.scope_id,
        fingerprint: liveClaim.credentials.replacement_service.fingerprint,
        status: 200,
        observed_at: now(-36),
        provider_date: providerDate(-36),
        request_id: "provider-binding-request",
      },
      issued_at: now(-35),
      expires_at: now(600),
    },
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-34),
    secretLeakGuard,
  });
}

function positiveControls(policy, credentials) {
  return [
    ["old_pat", "pat"],
    ["management_reader", "pat"],
    ["old_service", "service"],
    ["replacement_service", "service"],
  ].map(([credential, kind], index) => ({
    credential,
    endpoint_contract_sha256: credentialEndpointContractSha256(policy, kind),
    fingerprint: credentials[credential].fingerprint,
    status: 200,
    provider_code: "success",
    request_id: `precheck-${credential}-${index}`,
    observed_at: now(-25 + index),
    provider_date: providerDate(-25 + index),
  }));
}

function signedPrecheck(policy, liveClaim = claim(policy)) {
  const transitionBefore = sha256("runtime-before");
  const credentials = structuredClone(liveClaim.credentials);
  return signCredentialEvidence({
    document: {
      version: PRECHECK_VERSION,
      purpose: "precheck",
      transaction_id: TX,
      nonce: NONCE,
      policy_sha256: policySha256(policy),
      claim_sha256: sha256(canonicalCredentialJsonBytes(liveClaim)),
      candidate_sha: SHA_A,
      ci: ci(),
      transition_before_sha256: transitionBefore,
      credentials,
      positive_controls: positiveControls(policy, credentials),
      protected_assets_sha256: PROTECTED_ASSETS_SHA256,
      pre_cutover_invocation_id: PRE_CUTOVER_INVOCATION_ID,
      github: github("open"),
      supabase: supabase("precheck"),
      issued_at: now(-18),
      expires_at: now(600),
    },
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-17),
    secretLeakGuard,
  });
}

function signedRevocationProof(policy, precheck, transitionLastBytes) {
  const transitionLastSha = sha256(transitionLastBytes);
  const credentials = structuredClone(precheck.credentials);
  return signCredentialEvidence({
    document: {
      version: REVOCATION_PROOF_VERSION,
      purpose: "revocation_proof",
      transaction_id: TX,
      nonce: NONCE,
      policy_sha256: policySha256(policy),
      candidate_sha: SHA_A,
      ci: ci(),
      precheck_sha256: sha256(canonicalCredentialJsonBytes(precheck)),
      transition: {
        last_sha256: transitionLastSha,
        status: "awaiting_provider_revocation",
        ci_run_id: RUN,
        ci_run_attempt: ATTEMPT,
        before_sha256: sha256("runtime-before"),
        after_sha256: sha256("runtime-after"),
      },
      credentials,
      github: github("open", -11),
      supabase: supabase("completion", -14),
      sandwiches: {
        pat: sandwich(
          policy,
          "pat",
          credentials.old_pat.fingerprint,
          credentials.management_reader.fingerprint,
          -14,
          -13,
        ),
        service: sandwich(
          policy,
          "service",
          credentials.old_service.fingerprint,
          credentials.replacement_service.fingerprint,
          -14,
          -13,
        ),
      },
      protected_assets_sha256: PROTECTED_ASSETS_SHA256,
      pre_cutover_invocation_id: PRE_CUTOVER_INVOCATION_ID,
      post_cutover_invocation_id: POST_CUTOVER_INVOCATION_ID,
      consumers: consumers(
        policy,
        transitionLastSha,
        credentials.replacement_service.fingerprint,
        POST_CUTOVER_INVOCATION_ID,
        -14,
      ),
      issued_at: now(-10),
      expires_at: now(600),
    },
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-9),
    secretLeakGuard,
  });
}

function signedCompletion(policy, precheck, transitionLastBytes) {
  const transitionLastSha = sha256(transitionLastBytes);
  const credentials = structuredClone(precheck.credentials);
  const revocationProof = signedRevocationProof(policy, precheck, transitionLastBytes);
  return signCredentialEvidence({
    document: {
      version: COMPLETION_VERSION,
      purpose: "completion",
      transaction_id: TX,
      nonce: NONCE,
      policy_sha256: policySha256(policy),
      candidate_sha: SHA_A,
      ci: ci(),
      precheck_sha256: sha256(canonicalCredentialJsonBytes(precheck)),
      transition: {
        last_sha256: transitionLastSha,
        status: "awaiting_provider_revocation",
        ci_run_id: RUN,
        ci_run_attempt: ATTEMPT,
        before_sha256: sha256("runtime-before"),
        after_sha256: sha256("runtime-after"),
      },
      credentials,
      github: github("resolved", -6),
      supabase: supabase("completion", -9),
      sandwiches: {
        pat: sandwich(
          policy,
          "pat",
          credentials.old_pat.fingerprint,
          credentials.management_reader.fingerprint,
          -9,
          -8,
        ),
        service: sandwich(
          policy,
          "service",
          credentials.old_service.fingerprint,
          credentials.replacement_service.fingerprint,
          -9,
          -8,
        ),
      },
      protected_assets_sha256: PROTECTED_ASSETS_SHA256,
      pre_cutover_invocation_id: PRE_CUTOVER_INVOCATION_ID,
      post_cutover_invocation_id: POST_CUTOVER_INVOCATION_ID,
      consumers: consumers(
        policy,
        transitionLastSha,
        credentials.replacement_service.fingerprint,
        POST_CUTOVER_INVOCATION_ID,
        -9,
      ),
      revocation_proof: revocationProof,
      issued_at: now(-5),
      expires_at: now(31_000_000),
    },
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-4),
    secretLeakGuard,
  });
}

function transitionLastBytes(precheck) {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    status: "awaiting_provider_revocation",
    transaction_id: TX,
    precheck_sha256: sha256(canonicalCredentialJsonBytes(precheck)),
    candidate_sha: SHA_A,
    ci_run_id: RUN,
    ci_run_attempt: ATTEMPT,
    finished_at: now(-16),
    before_sha256: sha256("runtime-before"),
    after_sha256: sha256("runtime-after"),
  })}\n`);
}

function signedReadback(policy, liveClaim, precheck, completion, transitionBytes) {
  const transitionLastSha = sha256(transitionBytes);
  const freshGithub = github("resolved", -4);
  freshGithub.alerts = structuredClone(completion.github.alerts);
  return signCredentialEvidence({
    document: {
      version: READBACK_VERSION,
      purpose: "readback",
      transaction_id: TX,
      nonce: NONCE,
      policy_sha256: policySha256(policy),
      completion_sha256: sha256(canonicalCredentialJsonBytes(completion)),
      remediation_sha: SHA_A,
      release_sha: SHA_B,
      ci: ci(SHA_B),
      claim: liveClaim,
      precheck,
      github: freshGithub,
      supabase: supabase("completion", -4),
      sandwiches: {
        pat: sandwich(
          policy,
          "pat",
          completion.credentials.old_pat.fingerprint,
          completion.credentials.management_reader.fingerprint,
          -4,
          -3,
        ),
        service: sandwich(
          policy,
          "service",
          completion.credentials.old_service.fingerprint,
          completion.credentials.replacement_service.fingerprint,
          -4,
          -3,
        ),
      },
      protected_assets_sha256: PROTECTED_ASSETS_SHA256,
      post_cutover_invocation_id: POST_CUTOVER_INVOCATION_ID,
      service_probe: {
        status: 200,
        provider_code: "success",
        request_id: "service-readback-request",
        fingerprint: completion.credentials.replacement_service.fingerprint,
        observed_at: now(-4),
        provider_date: providerDate(-4),
      },
      consumers: consumers(
        policy,
        transitionLastSha,
        completion.credentials.replacement_service.fingerprint,
        POST_CUTOVER_INVOCATION_ID,
        -5,
      ),
      relation: measuredRelation(),
      observed_at: now(-2),
      expires_at: now(600),
    },
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-1),
    secretLeakGuard,
  });
}

function signedReadbackAt(policy, liveClaim, precheck, completion, transitionBytes, baseMs) {
  const iso = (offsetSeconds = 0) => new Date(baseMs + offsetSeconds * 1000).toISOString().replace(".000Z", "Z");
  const rfc = (offsetSeconds = 0) => new Date(baseMs + offsetSeconds * 1000).toUTCString();
  const readback = Object.fromEntries(Object.entries(
    signedReadback(policy, liveClaim, precheck, completion, transitionBytes),
  ).filter(([key]) => key !== "receipt"));
  readback.ci.completed_at = iso(-120);
  readback.ci.verified_at = iso(-60);
  readback.ci.requests.forEach((request, index) => {
    const offset = -61 + index;
    request.observed_at = iso(offset);
    request.provider_date = rfc(offset);
  });
  readback.github.observed_at = iso(-4);
  readback.github.provider_date = rfc(-4);
  readback.github.requests.forEach((request) => {
    request.observed_at = iso(-4);
    request.provider_date = rfc(-4);
  });
  readback.supabase.observed_at = iso(-4);
  readback.supabase.provider_date = rfc(-4);
  for (const evidence of Object.values(readback.sandwiches)) {
    evidence.started_at = iso(-4);
    evidence.finished_at = iso(-3);
    evidence.steps.forEach((step, index) => {
      const offset = -4 + index / 2;
      step.observed_at = iso(offset);
      step.provider_date = rfc(offset);
    });
  }
  readback.service_probe.observed_at = iso(-4);
  readback.service_probe.provider_date = rfc(-4);
  readback.consumers.forEach((consumer, index) => {
    consumer.observed_at = iso(-5 + index);
    consumer.evidence_sha256 = consumerEvidenceDigest(consumer);
  });
  readback.observed_at = iso(-2);
  readback.expires_at = iso(600);
  return signCredentialEvidence({
    document: readback,
    privateKeyBytes,
    publicKeyBytes,
    signedAt: iso(-1),
    secretLeakGuard,
  });
}

function signedTombstone(policy, completion, readback) {
  return signCredentialEvidence({
    document: {
      version: TOMBSTONE_VERSION,
      purpose: "tombstone",
      state: "consumed",
      transaction_id: TX,
      nonce: NONCE,
      candidate_sha: SHA_A,
      release_sha: SHA_B,
      ci_run_id: RUN,
      ci_run_attempt: ATTEMPT,
      transition_last_sha256: completion.transition.last_sha256,
      completion_sha256: sha256(canonicalCredentialJsonBytes(completion)),
      readback_sha256: sha256(canonicalCredentialJsonBytes(readback)),
      consumed_at: now(0),
    },
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(0),
    secretLeakGuard,
  });
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error instanceof CredentialLiveError && error.code === code);
}

function resign(document, signedAt = now(-5)) {
  return signCredentialEvidence({
    document: Object.fromEntries(Object.entries(document).filter(([key]) => key !== "receipt")),
    privateKeyBytes,
    publicKeyBytes,
    signedAt,
    secretLeakGuard,
  });
}

test("the committed live policy keeps reviewed provider identities but remains fail-closed until the public-key digests are stamped", () => {
  const committed = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
  assert.deepEqual(committed.credential_identities, {
    old_pat: { provider_object_id: "github-secret-alert-1", scope_id: "account-owner", provider_kind: "pat" },
    management_reader: { provider_object_id: "management-reader-prod", scope_id: "project-vfopmpxlhwzpxqegayew", provider_kind: "pat" },
    old_service: { provider_object_id: "service_role", scope_id: "project-vfopmpxlhwzpxqegayew", provider_kind: "legacy_service_role" },
    replacement_service: { provider_object_id: "d67a8b16-3a54-45b1-b457-eb6b7a3e2a9a", scope_id: "project-vfopmpxlhwzpxqegayew", provider_kind: "secret" },
  });
  assertCode(() => validateCredentialLivePolicy(committed), "policy_receipt_trust_root_unstamped");
  const unstampedIdentity = policyFixture();
  unstampedIdentity.credential_identities.old_pat.provider_object_id = "UNSTAMPED";
  assertCode(() => validateCredentialLivePolicy(unstampedIdentity), "policy_credential_identities_unstamped");
  const trustRootUnstamped = policyFixture();
  trustRootUnstamped.receipts.public_key_file_sha256 = "0".repeat(64);
  trustRootUnstamped.receipts.public_key_spki_sha256 = "0".repeat(64);
  assertCode(() => validateCredentialLivePolicy(trustRootUnstamped), "policy_receipt_trust_root_unstamped");
  for (const tokenShapedId of [
    `sbp_${"a".repeat(40)}`,
    `sb_secret_${"b".repeat(40)}`,
    `eyJ${"c".repeat(40)}`,
    `${"a".repeat(36)}.${"b".repeat(36)}.${"c".repeat(36)}`,
  ]) {
    const unsafeIdentity = policyFixture();
    unsafeIdentity.credential_identities.old_pat.provider_object_id = tokenShapedId;
    assertCode(() => validateCredentialLivePolicy(unsafeIdentity), "policy_credential_identities_invalid");
  }
  assert.doesNotThrow(() => validateCredentialLivePolicy(policyFixture()));
});

test("the installed live verifier accepts only the exact protected control-plane marker", () => {
  const assetBytesByPath = Object.fromEntries(Object.keys(PROTECTED_CONTROL_PLANE_ASSETS).map((assetPath) => [
    assetPath,
    Buffer.from(`reviewed bytes for ${assetPath}`),
  ]));
  const marker = {
    version: 2,
    candidate_sha: SHA_A,
    activated_at: now(-60),
    assets: Object.fromEntries(Object.entries(assetBytesByPath).map(([assetPath, bytes]) => [assetPath, sha256(bytes)])),
  };
  const markerBytes = Buffer.from(`${JSON.stringify(marker)}\n`);
  assert.equal(validateInstalledProtectionMarker(markerBytes, { assetBytesByPath }).sha256, sha256(markerBytes));

  const substituted = { ...assetBytesByPath, "/usr/local/sbin/newme-deploy": Buffer.from("substituted") };
  assertCode(
    () => validateInstalledProtectionMarker(markerBytes, { assetBytesByPath: substituted }),
    "protected_marker_asset_digest_mismatch",
  );
  assertCode(
    () => validateInstalledProtectionMarker(Buffer.from(`${JSON.stringify({ ...marker, version: 3 })}\n`), { assetBytesByPath }),
    "protected_marker_invalid",
  );
});

test("credential fingerprints are nonce, transaction, key-id, and kind separated HMACs", () => {
  const policy = policyFixture();
  const values = fingerprints(policy);
  assert.equal(new Set(Object.values(values)).size, 4);
  assert.notEqual(values.old_pat, sha256("synthetic-old_pat-credential-value-never-persisted"));
  const differentNonce = credentialFingerprint({
    keyBytes: fingerprintKey,
    keyId: policy.fingerprints.key_id,
    transactionId: TX,
    nonce: randomBytes(32).toString("base64url"),
    kind: "old_pat",
    secretBytes: Buffer.from("synthetic-old_pat-credential-value-never-persisted"),
  });
  assert.notEqual(differentNonce, values.old_pat);
});

test("credential receipts bind metadata, require a matching key pair, and refuse undeclared secret fields", () => {
  const policy = policyFixture();
  const liveClaim = claim(policy);
  const providerReceipt = signedProviderIdentityReceipt(policy, liveClaim);
  assert.doesNotThrow(() => validateProviderIdentityReceipt(providerReceipt, {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }));
  for (const mutate of [
    (receipt) => { receipt.provider_binding.provider_object_id = "service-unrelated-3"; },
    (receipt) => { receipt.provider_binding.fingerprint = receipt.credentials.old_service.fingerprint; },
    (receipt) => { receipt.provider_binding.endpoint_contract_sha256 = sha256("wrong-provider-endpoint"); },
    (receipt) => { receipt.provider_binding.provider_kind = "legacy_service_role"; },
  ]) {
    const changed = structuredClone(providerReceipt);
    mutate(changed);
    assertCode(() => validateProviderIdentityReceipt(changed, {
      policy,
      publicKeyBytes,
      claim: liveClaim,
      nowMs: NOW,
    }), "provider_identity_binding_invalid");
  }
  const precheck = signedPrecheck(policy, liveClaim);
  const tamperedSignedAt = structuredClone(precheck);
  tamperedSignedAt.receipt.signed_at = now(-16);
  assertCode(
    () => validatePrecheck(tamperedSignedAt, { policy, publicKeyBytes, claim: liveClaim, nowMs: NOW }),
    "receipt_signature_invalid",
  );

  const otherKeys = generateKeyPairSync("ed25519");
  const otherPublic = otherKeys.publicKey.export({ type: "spki", format: "pem" });
  assertCode(() => signCredentialEvidence({
    document: Object.fromEntries(Object.entries(precheck).filter(([key]) => key !== "receipt")),
    privateKeyBytes,
    publicKeyBytes: otherPublic,
    signedAt: now(-5),
    secretLeakGuard,
  }), "receipt_key_pair_mismatch");

  const unsignedPrecheck = Object.fromEntries(Object.entries(precheck).filter(([key]) => key !== "receipt"));
  for (const omitted of Object.keys(secretLeakGuard)) {
    const incompleteGuard = Object.fromEntries(
      Object.entries(secretLeakGuard).filter(([kind]) => kind !== omitted),
    );
    assertCode(() => signCredentialEvidence({
      document: unsignedPrecheck,
      privateKeyBytes,
      publicKeyBytes,
      signedAt: now(-5),
      secretLeakGuard: incompleteGuard,
    }), "secret_leak_guard_missing");
  }
  assertCode(() => signCredentialEvidence({
    document: unsignedPrecheck,
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-5),
    secretLeakGuard: { ...secretLeakGuard, extra: Buffer.from("synthetic-extra-secret-value") },
  }), "secret_leak_guard_missing");
  assertCode(() => signCredentialEvidence({
    document: unsignedPrecheck,
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-5),
    secretLeakGuard: { ...secretLeakGuard, old_pat: SYNTHETIC_SECRETS.old_pat },
  }), "secret_leak_guard_invalid");
  assertCode(() => signCredentialEvidence({
    document: unsignedPrecheck,
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-5),
    secretLeakGuard: { ...secretLeakGuard, old_pat: secretLeakGuard.management_reader },
  }), "secret_leak_guard_invalid");

  const leakBytes = secretLeakGuard.old_service;
  for (const encoded of [
    leakBytes.toString("utf8"),
    encodeURIComponent(leakBytes.toString("utf8")),
    leakBytes.toString("hex"),
    leakBytes.toString("base64"),
    leakBytes.toString("base64url"),
  ]) {
    const encodedLeak = structuredClone(unsignedPrecheck);
    encodedLeak.pre_cutover_invocation_id = encoded;
    assertCode(() => signCredentialEvidence({
      document: encodedLeak,
      privateKeyBytes,
      publicKeyBytes,
      signedAt: now(-5),
      secretLeakGuard,
    }), "secret_material_in_evidence");
  }

  assertCode(() => signCredentialEvidence({
    document: {
      ...Object.fromEntries(Object.entries(precheck).filter(([key]) => key !== "receipt")),
      raw_secret: "synthetic-secret-must-never-be-signed",
    },
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-5),
    secretLeakGuard,
  }), "evidence_shape_invalid");

  const nestedLeak = structuredClone(Object.fromEntries(Object.entries(precheck).filter(([key]) => key !== "receipt")));
  nestedLeak.pre_cutover_invocation_id = SYNTHETIC_SECRETS.old_service;
  assertCode(() => signCredentialEvidence({
    document: nestedLeak,
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-5),
    secretLeakGuard,
  }), "secret_material_in_evidence");

  const nonCanonicalSignature = structuredClone(precheck);
  const canonicalLast = nonCanonicalSignature.receipt.signature.at(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const canonicalIndex = alphabet.indexOf(canonicalLast);
  const aliasIndex = canonicalIndex ^ 1;
  nonCanonicalSignature.receipt.signature = `${nonCanonicalSignature.receipt.signature.slice(0, -1)}${alphabet[aliasIndex]}`;
  assert.deepEqual(
    Buffer.from(nonCanonicalSignature.receipt.signature, "base64url"),
    Buffer.from(precheck.receipt.signature, "base64url"),
  );
  assertCode(
    () => validatePrecheck(nonCanonicalSignature, { policy, publicKeyBytes, claim: liveClaim, nowMs: NOW }),
    "receipt_signature_invalid",
  );

  assertCode(() => canonicalCredentialJsonBytes({ invalid: "\ud800" }), "canonical_json_invalid");
});

test("precheck binds the exact claim, CI attempt, old credential positive controls, and provider identities", () => {
  const policy = policyFixture();
  const liveClaim = claim(policy);
  const precheck = signedPrecheck(policy, liveClaim);
  assert.doesNotThrow(() => validatePrecheck(precheck, { policy, publicKeyBytes, claim: liveClaim, nowMs: NOW }));

  const badCi = structuredClone(precheck);
  badCi.ci.run_id = "not-a-run-id";
  assertCode(() => validatePrecheck(resign(badCi), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }), "ci_identity_invalid");

  const badClaimDigest = structuredClone(precheck);
  badClaimDigest.claim_sha256 = "f".repeat(64);
  assertCode(() => validatePrecheck(resign(badClaimDigest), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }), "precheck_claim_invalid");

  const futureCiProviderDate = structuredClone(precheck);
  futureCiProviderDate.ci.requests[1].provider_date = new Date(NOW + 300_000).toUTCString();
  assertCode(() => validatePrecheck(resign(futureCiProviderDate), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }), "ci_request_transcript_invalid");
  const replayedCiRequest = structuredClone(precheck);
  replayedCiRequest.ci.requests[1].request_id = replayedCiRequest.ci.requests[0].request_id;
  assertCode(() => validatePrecheck(resign(replayedCiRequest), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }), "ci_request_transcript_invalid");

  const noOldPatSuccess = structuredClone(precheck);
  noOldPatSuccess.positive_controls[0].status = 401;
  assertCode(() => validatePrecheck(resign(noOldPatSuccess), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }), "positive_control_invalid");
  const replayedPositiveControl = structuredClone(precheck);
  replayedPositiveControl.positive_controls[3].request_id = replayedPositiveControl.positive_controls[0].request_id;
  assertCode(() => validatePrecheck(resign(replayedPositiveControl), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }), "positive_control_invalid");

  const unboundProvider = structuredClone(precheck);
  unboundProvider.supabase.old_service.provider_object_id = "unrelated-service-key";
  assertCode(() => validatePrecheck(resign(unboundProvider), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }), "supabase_provider_identity_unbound");
});

test("the claim binds transaction, nonce, run attempt, four distinct identities, and a short TTL", () => {
  const policy = policyFixture();
  const claim = {
    version: CLAIM_VERSION,
    transaction_id: TX,
    nonce: NONCE,
    candidate_sha: SHA_A,
    ci_run_id: RUN,
    ci_run_attempt: ATTEMPT,
    created_at: now(-10),
    expires_at: now(600),
    credentials: identitySet(policy),
  };
  assert.doesNotThrow(() => validateCredentialClaim(claim, policy, { nowMs: NOW }));
  assertCode(() => validateCredentialClaim({ ...claim, ci_run_attempt: 0 }, policy, { nowMs: NOW }), "claim_identity_invalid");
  assertCode(() => validateCredentialClaim({ ...claim, expires_at: now(901) }, policy, { nowMs: NOW }), "claim_expired");
  const crossProject = structuredClone(claim);
  crossProject.credentials.old_service.scope_id = "project-other";
  crossProject.credentials.replacement_service.scope_id = "project-other";
  assertCode(
    () => validateCredentialClaim(crossProject, policy, { nowMs: NOW }),
    "credential_provider_identity_invalid",
  );
});

test("GitHub evidence requires both fixed alerts, hide_secret, complete pagination, and revoked closure", () => {
  const policy = policyFixture();
  assert.doesNotThrow(() => validateGithubEvidence(github("resolved"), policy, { requiredState: "resolved", nowMs: NOW }));
  assertCode(() => validateGithubEvidence({ ...github("resolved"), hide_secret: false }, policy, { requiredState: "resolved", nowMs: NOW }), "github_evidence_invalid");
  assertCode(() => validateGithubEvidence({ ...github("resolved"), open_count: 1 }, policy, { requiredState: "resolved", nowMs: NOW }), "github_open_alerts_remain");
  const replayedRequests = github("resolved");
  replayedRequests.requests[1].request_id = replayedRequests.requests[0].request_id;
  replayedRequests.requests[2].request_id = replayedRequests.requests[0].request_id;
  assertCode(
    () => validateGithubEvidence(replayedRequests, policy, { requiredState: "resolved", nowMs: NOW }),
    "github_request_transcript_invalid",
  );
  assertCode(() => validateGithubEvidence({ ...github("open"), open_count: 0 }, policy, { requiredState: "open", nowMs: NOW }), "github_open_count_inconsistent");
  const missingProviderDate = github("resolved");
  delete missingProviderDate.provider_date;
  assertCode(() => validateGithubEvidence(missingProviderDate, policy, { requiredState: "resolved", nowMs: NOW }), "github_evidence_shape_invalid");
  const futureProviderDate = github("resolved");
  futureProviderDate.provider_date = new Date(NOW + 300_000).toUTCString();
  assertCode(() => validateGithubEvidence(futureProviderDate, policy, { requiredState: "resolved", nowMs: NOW }), "github_evidence_stale");
  const dismissed = github("resolved");
  dismissed.alerts[0].resolution = "false_positive";
  assertCode(() => validateGithubEvidence(dismissed, policy, { requiredState: "resolved", nowMs: NOW }), "github_alert_not_revoked");
});

test("GitHub next links advance exactly one page with a closed query and no replay", () => {
  const origin = "https://api.github.com";
  const basePath = "/repos/69755354/newme-platform/secret-scanning/alerts";
  const visitedUrls = new Set([
    `${origin}${basePath}?state=open&hide_secret=true&per_page=100&page=1`,
  ]);
  const valid = `<${origin}${basePath}?state=open&hide_secret=true&per_page=100&page=2>; rel="next"`;
  assert.equal(githubNextLink(valid, { origin, basePath, currentPage: 1, visitedUrls }),
    `${origin}${basePath}?state=open&hide_secret=true&per_page=100&page=2`);
  for (const invalid of [
    `<${origin}${basePath}?state=open&hide_secret=true&per_page=100&page=1>; rel="next"`,
    `<${origin}${basePath}?state=open&hide_secret=true&per_page=100&page=3>; rel="next"`,
    `<${origin}${basePath}?state=open&hide_secret=true&per_page=100&page=2&page=2>; rel="next"`,
    `<${origin}${basePath}?state=open&hide_secret=true&per_page=100&page=2&extra=1>; rel="next"`,
  ]) {
    assertCode(
      () => githubNextLink(invalid, { origin, basePath, currentPage: 1, visitedUrls }),
      "github_alert_pagination_invalid",
    );
  }
});

test("Supabase evidence requires replacement identity and proves the old provider object absent", () => {
  const policy = policyFixture();
  const credentials = identitySet(policy);
  assert.doesNotThrow(() => validateSupabaseEvidence(supabase("completion"), policy, {
    stage: "completion",
    nowMs: NOW,
    credentials,
  }));
  const oldStillPresent = supabase("completion");
  oldStillPresent.old_service.present = true;
  assertCode(() => validateSupabaseEvidence(oldStillPresent, policy, { stage: "completion", nowMs: NOW, credentials }), "old_service_provider_still_present");
  const noReplacement = supabase("completion");
  noReplacement.replacement_service.present = false;
  assertCode(() => validateSupabaseEvidence(noReplacement, policy, { stage: "completion", nowMs: NOW, credentials }), "replacement_service_provider_not_bound");
  const crossProject = supabase("completion");
  crossProject.replacement_service.scope_id = "project-other";
  assertCode(() => validateSupabaseEvidence(crossProject, policy, { stage: "completion", nowMs: NOW, credentials }), "supabase_provider_identity_unbound");
});

test("the live Supabase collector requires a signed provider identity receipt in addition to inventory presence", async () => {
  const policy = policyFixture();
  const liveClaim = claim(policy);
  const credentials = liveClaim.credentials;
  const providerIdentityReceipt = signedProviderIdentityReceipt(policy, liveClaim);
  const responseBody = [
    { id: "anon", type: "legacy" },
    { id: "publishable-current", type: "publishable" },
    { id: credentials.old_service.provider_object_id, type: "secret" },
    { id: credentials.replacement_service.provider_object_id, type: "secret" },
  ];
  const fetchImpl = async () => new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      "content-type": "application/json",
      date: providerDate(),
      "x-request-id": "supabase-inventory-request-1",
    },
  });
  const evidence = await collectSupabaseEvidence({
    fetchImpl,
    policy,
    token: Buffer.from(SYNTHETIC_SECRETS.management_reader),
    credentials,
    stage: "precheck",
    nowMs: () => NOW,
    providerIdentityReceipt,
    publicKeyBytes,
    claim: liveClaim,
  });
  assert.equal(evidence.old_service.policy_identity_match, true);
  assert.equal(evidence.replacement_service.policy_identity_match, true);
  assert.doesNotThrow(() => validateProviderIdentityReceipt(providerIdentityReceipt, {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    nowMs: NOW,
  }));

  const tamperedReceipt = structuredClone(providerIdentityReceipt);
  tamperedReceipt.credentials.replacement_service.provider_object_id = "service-unrelated-3";
  await assert.rejects(
    collectSupabaseEvidence({
      fetchImpl,
      policy,
      token: Buffer.from(SYNTHETIC_SECRETS.management_reader),
      credentials,
      stage: "precheck",
      nowMs: () => NOW,
      providerIdentityReceipt: tamperedReceipt,
      publicKeyBytes,
      claim: liveClaim,
    }),
    (error) => error instanceof CredentialLiveError && error.code === "provider_identity_receipt_invalid",
  );
});

test("PAT and service revocation are exact new-200 old-401 new-200 sandwiches", () => {
  const policy = policyFixture();
  const identities = identitySet(policy);
  const valid = sandwich(policy, "pat", identities.old_pat.fingerprint, identities.management_reader.fingerprint);
  assert.doesNotThrow(() => validateSandwich(valid, {
    kind: "pat",
    oldFingerprint: identities.old_pat.fingerprint,
    replacementFingerprint: identities.management_reader.fingerprint,
    policy,
    nowMs: NOW,
    notBeforeMs: NOW - 20_000,
  }));
  const replayed = structuredClone(valid);
  replayed.steps[2].request_id = replayed.steps[0].request_id;
  assertCode(() => validateSandwich(replayed, {
    kind: "pat",
    oldFingerprint: identities.old_pat.fingerprint,
    replacementFingerprint: identities.management_reader.fingerprint,
    policy,
    nowMs: NOW,
    notBeforeMs: NOW - 20_000,
  }), "sandwich_request_replayed");
  for (const status of [200, 204, 400, 403, 404, 429, 500]) {
    const invalid = structuredClone(valid);
    invalid.steps[1].status = status;
    assertCode(() => validateSandwich(invalid, {
      kind: "pat",
      oldFingerprint: identities.old_pat.fingerprint,
      replacementFingerprint: identities.management_reader.fingerprint,
      policy,
      nowMs: NOW,
      notBeforeMs: NOW - 20_000,
    }), "sandwich_result_invalid");
  }
  const wrongEndpoint = structuredClone(valid);
  wrongEndpoint.endpoint_contract_sha256 = sha256("attacker endpoint");
  assertCode(() => validateSandwich(wrongEndpoint, {
    kind: "pat",
    oldFingerprint: identities.old_pat.fingerprint,
    replacementFingerprint: identities.management_reader.fingerprint,
    policy,
    nowMs: NOW,
    notBeforeMs: NOW - 20_000,
  }), "sandwich_endpoint_invalid");
  const futureProviderDate = structuredClone(valid);
  futureProviderDate.steps[1].provider_date = new Date(NOW + 300_000).toUTCString();
  assertCode(() => validateSandwich(futureProviderDate, {
    kind: "pat",
    oldFingerprint: identities.old_pat.fingerprint,
    replacementFingerprint: identities.management_reader.fingerprint,
    policy,
    nowMs: NOW,
    notBeforeMs: NOW - 20_000,
  }), "sandwich_time_invalid");
});

test("signed revocation proof binds provider revocation before the final GitHub-open observation", () => {
  const policy = policyFixture();
  const liveClaim = claim(policy);
  const precheck = signedPrecheck(policy, liveClaim);
  const transitionBytes = transitionLastBytes(precheck);
  const proof = signedRevocationProof(policy, precheck, transitionBytes);
  assert.doesNotThrow(() => validateRevocationProof(proof, {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }));

  const oldStillValid = structuredClone(proof);
  oldStillValid.sandwiches.pat.steps[1].status = 200;
  oldStillValid.sandwiches.pat.steps[1].provider_code = "success";
  assertCode(() => validateRevocationProof(resign(oldStillValid, now(-9)), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "sandwich_result_invalid");

  const githubObservedTooEarly = structuredClone(proof);
  githubObservedTooEarly.github.observed_at = now(-15);
  githubObservedTooEarly.github.provider_date = providerDate(-15);
  githubObservedTooEarly.github.requests.forEach((request) => {
    request.observed_at = now(-15);
    request.provider_date = providerDate(-15);
  });
  assertCode(() => validateRevocationProof(resign(githubObservedTooEarly, now(-9)), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "github_request_transcript_invalid");
});

test("signed completion binds precheck, attempt, transition bytes, live provider facts, and consumers", () => {
  const policy = policyFixture();
  const liveClaim = claim(policy);
  const precheck = signedPrecheck(policy, liveClaim);
  const transitionBytes = transitionLastBytes(precheck);
  // signCredentialEvidence hashes the canonical precheck bytes, so make the
  // completion use the same canonical representation as the validator.
  const completion = signedCompletion(policy, precheck, transitionBytes);
  completion.precheck_sha256 = sha256(canonicalCredentialJsonBytes(precheck));
  // Re-sign after the fixture correction.
  const resigned = signCredentialEvidence({
    document: Object.fromEntries(Object.entries(completion).filter(([key]) => key !== "receipt")),
    privateKeyBytes,
    publicKeyBytes,
    signedAt: now(-5),
    secretLeakGuard,
  });
  assert.doesNotThrow(() => validateCompletion(resigned, {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }));
  const wrongAttempt = structuredClone(resigned);
  wrongAttempt.ci.run_attempt = 3;
  assertCode(() => validateCompletion(wrongAttempt, { policy, publicKeyBytes, claim: liveClaim, precheck, transitionLastBytes: transitionBytes, nowMs: NOW }), "ci_identity_invalid");
  for (const [field, value] of [["ci_run_id", "999999"], ["ci_run_attempt", ATTEMPT + 1]]) {
    const mismatchedTransition = JSON.parse(transitionBytes.toString("utf8"));
    mismatchedTransition[field] = value;
    const mismatchedTransitionBytes = Buffer.from(`${JSON.stringify(mismatchedTransition)}\n`);
    const mismatchedCompletion = structuredClone(resigned);
    mismatchedCompletion.transition.last_sha256 = sha256(mismatchedTransitionBytes);
    mismatchedCompletion.transition[field] = value;
    assertCode(() => validateCompletion(resign(mismatchedCompletion), {
      policy,
      publicKeyBytes,
      claim: liveClaim,
      precheck,
      transitionLastBytes: mismatchedTransitionBytes,
      nowMs: NOW,
    }), "completion_transition_invalid");
  }
  const wrongTransition = Buffer.from('{"status":"different"}\n');
  assertCode(() => validateCompletion(resigned, { policy, publicKeyBytes, claim: liveClaim, precheck, transitionLastBytes: wrongTransition, nowMs: NOW }), "completion_transition_invalid");

  const wrongProjection = structuredClone(resigned);
  wrongProjection.transition.before_sha256 = sha256("invented-before-runtime");
  assertCode(() => validateCompletion(resign(wrongProjection), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "completion_transition_invalid");

  const staleSandwich = structuredClone(resigned);
  staleSandwich.sandwiches.pat.started_at = now(-1000);
  assertCode(() => validateCompletion(resign(staleSandwich), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "sandwich_time_invalid");

  const prematureResolution = structuredClone(resigned);
  prematureResolution.github.alerts.forEach((alert) => { alert.resolved_at = now(-17); });
  assertCode(() => validateCompletion(resign(prematureResolution), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "github_alert_not_revoked");

  const unboundConsumer = structuredClone(resigned);
  unboundConsumer.consumers[0].replacement_fingerprint = unboundConsumer.credentials.old_service.fingerprint;
  unboundConsumer.consumers[0].evidence_sha256 = consumerEvidenceDigest(unboundConsumer.consumers[0]);
  assertCode(() => validateCompletion(resign(unboundConsumer), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "consumer_evidence_invalid");

  const changedControlPlane = structuredClone(resigned);
  changedControlPlane.protected_assets_sha256 = "f".repeat(64);
  changedControlPlane.post_cutover_invocation_id = "substituted-service-invocation";
  for (const consumer of changedControlPlane.consumers) {
    consumer.protected_assets_sha256 = changedControlPlane.protected_assets_sha256;
    consumer.invocation_id = changedControlPlane.post_cutover_invocation_id;
    consumer.evidence_sha256 = consumerEvidenceDigest(consumer);
  }
  assertCode(() => validateCompletion(resign(changedControlPlane), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "completion_control_plane_mismatch");

  assert.doesNotThrow(() => validateCompletion(resigned, {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW + 701_000,
  }));
  assertCode(() => validateCompletion(resigned, {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW + 31_000_001_000,
  }), "completion_timestamp_invalid");

  const restartedBetweenProofAndCompletion = structuredClone(resigned);
  const proofForPriorInvocation = structuredClone(restartedBetweenProofAndCompletion.revocation_proof);
  proofForPriorInvocation.post_cutover_invocation_id = "service-invocation-proof-phase";
  for (const consumer of proofForPriorInvocation.consumers) {
    consumer.invocation_id = proofForPriorInvocation.post_cutover_invocation_id;
    consumer.evidence_sha256 = consumerEvidenceDigest(consumer);
  }
  restartedBetweenProofAndCompletion.revocation_proof = resign(proofForPriorInvocation, now(-9));
  const reboundCompletion = resign(restartedBetweenProofAndCompletion);
  assert.doesNotThrow(() => validateCompletion(reboundCompletion, {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "a fully revalidated completion may bind a newer service invocation than its signed revocation proof");

  const completionWithUnboundInvocation = structuredClone(reboundCompletion);
  completionWithUnboundInvocation.post_cutover_invocation_id = "service-invocation-unbound-completion";
  assertCode(() => validateCompletion(resign(completionWithUnboundInvocation), {
    policy,
    publicKeyBytes,
    claim: liveClaim,
    precheck,
    transitionLastBytes: transitionBytes,
    nowMs: NOW,
  }), "consumer_evidence_invalid");
});

test("first consumption requires an exact direct TASKBOARD-only closure commit", () => {
  const valid = {
    remediation_sha: SHA_A,
    release_sha: SHA_B,
    commit_count: 1,
    direct_parent: SHA_A,
    changed_paths: ["TASKBOARD.md"],
    per_commit_changed_paths: [["TASKBOARD.md"]],
  };
  assert.doesNotThrow(() => validateReleaseRelation(valid, {
    remediationSha: SHA_A,
    releaseSha: SHA_B,
    measureRelation: measuredRelation,
  }));
  assertCode(() => validateReleaseRelation({ ...valid, commit_count: 2 }, { remediationSha: SHA_A, releaseSha: SHA_B, measureRelation: measuredRelation }), "release_relation_invalid");
  assertCode(() => validateReleaseRelation({ ...valid, changed_paths: ["TASKBOARD.md", "src/app.ts"] }, { remediationSha: SHA_A, releaseSha: SHA_B, measureRelation: measuredRelation }), "release_relation_invalid");
  assertCode(() => validateReleaseRelation(valid, { remediationSha: SHA_A, releaseSha: SHA_B }), "release_relation_unmeasured");
});

test("consumption binds one fresh live readback, exact release CI, and the TASKBOARD-only relation", () => {
  const policy = policyFixture();
  const liveClaim = claim(policy);
  const precheck = signedPrecheck(policy, liveClaim);
  const transitionBytes = transitionLastBytes(precheck);
  const completion = signedCompletion(policy, precheck, transitionBytes);
  const readback = signedReadback(policy, liveClaim, precheck, completion, transitionBytes);
  assert.doesNotThrow(() => validateReadback(readback, {
    policy,
    publicKeyBytes,
    completion,
    transitionLastBytes: transitionBytes,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW,
  }));
  const restartedBeforeReadback = structuredClone(readback);
  restartedBeforeReadback.post_cutover_invocation_id = "service-invocation-readback-phase";
  for (const consumer of restartedBeforeReadback.consumers) {
    consumer.invocation_id = restartedBeforeReadback.post_cutover_invocation_id;
    consumer.evidence_sha256 = consumerEvidenceDigest(consumer);
  }
  const reboundReadback = resign(restartedBeforeReadback, now(-1));
  assert.doesNotThrow(() => validateReadback(reboundReadback, {
    policy,
    publicKeyBytes,
    completion,
    transitionLastBytes: transitionBytes,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW,
  }), "a fresh readback may bind a newer fully revalidated service invocation than the historical completion");

  const readbackWithUnboundInvocation = structuredClone(readback);
  readbackWithUnboundInvocation.post_cutover_invocation_id = "service-invocation-unbound-readback";
  assertCode(() => validateReadback(resign(readbackWithUnboundInvocation, now(-1)), {
    policy,
    publicKeyBytes,
    completion,
    transitionLastBytes: transitionBytes,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW,
  }), "consumer_evidence_invalid");
  const tombstone = signedTombstone(policy, completion, readback);
  assert.doesNotThrow(() => validateTombstone(tombstone, {
    policy,
    publicKeyBytes,
    completion,
    precheck,
    claim: liveClaim,
    transitionLastBytes: transitionBytes,
    readback,
    expectedReleaseSha: SHA_B,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW,
  }));
  assert.doesNotThrow(() => validateTombstone(tombstone, {
    policy,
    publicKeyBytes,
    completion,
    precheck,
    claim: liveClaim,
    transitionLastBytes: transitionBytes,
    readback,
    expectedReleaseSha: SHA_B,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW + 10 * 24 * 60 * 60 * 1000,
  }), "a signed tombstone remains verifiable after the readback TTL expires");

  const wrongRun = structuredClone(readback);
  wrongRun.ci.run_id = "999999";
  assertCode(() => validateReadback(resign(wrongRun), {
    policy,
    publicKeyBytes,
    completion,
    transitionLastBytes: transitionBytes,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW,
  }), "ci_identity_invalid");

  const replayedReadback = structuredClone(readback);
  replayedReadback.relation.commit_count = 2;
  const replayedTombstone = structuredClone(tombstone);
  replayedTombstone.readback_sha256 = sha256(canonicalCredentialJsonBytes(resign(replayedReadback)));
  assertCode(() => validateTombstone(resign(replayedTombstone), {
    policy,
    publicKeyBytes,
    completion,
    precheck,
    claim: liveClaim,
    transitionLastBytes: transitionBytes,
    readback: resign(replayedReadback),
    expectedReleaseSha: SHA_B,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW,
  }), "release_relation_invalid");

  const prematureTombstone = structuredClone(tombstone);
  prematureTombstone.consumed_at = now(-6);
  assertCode(() => validateTombstone(resign(prematureTombstone, now(-1)), {
    policy,
    publicKeyBytes,
    completion,
    precheck,
    claim: liveClaim,
    transitionLastBytes: transitionBytes,
    readback,
    expectedReleaseSha: SHA_B,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: NOW,
  }), "tombstone_timestamp_invalid");
});

test("an unexpired historical completion accepts a fresh readback after the precheck TTL", () => {
  const policy = policyFixture();
  const liveClaim = claim(policy);
  const precheck = signedPrecheck(policy, liveClaim);
  const transitionBytes = transitionLastBytes(precheck);
  const completion = signedCompletion(policy, precheck, transitionBytes);
  const laterNow = NOW + (policy.precheck_ttl_seconds + 1) * 1000;
  const readback = signedReadbackAt(policy, liveClaim, precheck, completion, transitionBytes, laterNow);
  assert.doesNotThrow(() => validateReadback(readback, {
    policy,
    publicKeyBytes,
    completion,
    transitionLastBytes: transitionBytes,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: laterNow,
  }));

  const iso = (offsetSeconds = 0) => new Date(laterNow + offsetSeconds * 1000).toISOString().replace(".000Z", "Z");
  const tombstoneDocument = Object.fromEntries(Object.entries(
    signedTombstone(policy, completion, readback),
  ).filter(([key]) => key !== "receipt"));
  tombstoneDocument.consumed_at = iso(0);
  const tombstone = signCredentialEvidence({
    document: tombstoneDocument,
    privateKeyBytes,
    publicKeyBytes,
    signedAt: iso(0),
    secretLeakGuard,
  });
  assert.doesNotThrow(() => validateTombstone(tombstone, {
    policy,
    publicKeyBytes,
    completion,
    precheck,
    claim: liveClaim,
    transitionLastBytes: transitionBytes,
    readback,
    expectedReleaseSha: SHA_B,
    expectedRun: RUN,
    expectedAttempt: ATTEMPT,
    measureReleaseRelation: measuredRelation,
    nowMs: laterNow,
  }));
});

test("the durable state machine cannot skip precheck, cutover, or signed completion", () => {
  assert.equal(transitionCredentialLiveState("ABSENT", "prepare"), "PREPARED");
  assert.equal(transitionCredentialLiveState("PREPARED", "cutover"), "CUTOVER_INFLIGHT");
  assert.equal(transitionCredentialLiveState("CUTOVER_INFLIGHT", "retry"), "CUTOVER_INFLIGHT");
  assert.equal(transitionCredentialLiveState("CUTOVER_INFLIGHT", "attest"), "COMPLETE");
  assert.equal(transitionCredentialLiveState("COMPLETE", "consume"), "CONSUMED");
  assert.equal(transitionCredentialLiveState("PREPARED", "expire"), "EXPIRED");
  assertCode(() => transitionCredentialLiveState("CONSUMED", "consume"), "state_transition_invalid");
  assertCode(() => transitionCredentialLiveState("ABSENT", "attest"), "state_transition_invalid");
  assertCode(() => transitionCredentialLiveState("FAILED", "prepare"), "state_transition_invalid");
});

test("PREPARED reentry restores only escrow-bound one-use inputs before fresh probes", () => {
  const source = readFileSync(path.join(ROOT, "scripts", "credential-live-attestation.mjs"), "utf8");
  const prepareStart = source.indexOf("export async function prepareInstalledCredentialAttestation");
  const prepareEnd = source.indexOf("\nfunction readAwaitingInstalledContext", prepareStart);
  assert.ok(prepareStart > 0 && prepareEnd > prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.ok(prepare.indexOf("const recordedState = readLiveState(policy)") < prepare.indexOf("policy.inputs.old_pat_path"));
  assert.match(prepare, /previousState !== null[\s\S]*readCredentialEscrow\([\s\S]*restorePreparedInput\(policy\.inputs\.claim_path[\s\S]*restorePreparedInput\([\s\S]*policy\.inputs\.old_pat_path[\s\S]*restorePreparedInput\([\s\S]*policy\.inputs\.replacement_service_path/);
  assert.match(prepare, /precheckMustBeIssued = precheck\.pre_cutover_invocation_id !== preCutoverInvocationId/);
  assert.match(prepare, /collectCiEvidence[\s\S]*collectGithubEvidence[\s\S]*collectSupabaseEvidence[\s\S]*collectPositiveControls[\s\S]*measureInstalledControlPlane/);
});

test("expired PREPARED state has one protected idempotent cleanup path", () => {
  const source = readFileSync(path.join(ROOT, "scripts", "credential-live-attestation.mjs"), "utf8");
  const start = source.indexOf("export function expirePreparedCredentialAttestation");
  const end = source.indexOf("\nfunction readAwaitingInstalledContext", start);
  assert.ok(start > 0 && end > start);
  const expiry = source.slice(start, end);
  assert.match(expiry, /readCredentialEscrowForPreparedExpiry/);
  assert.match(expiry, /claimExpiresMs > nowMs/);
  assert.match(expiry, /prepared_runtime_identity_mismatch/);
  assert.match(expiry, /transitionCredentialLiveState\("PREPARED", "expire"\)/);
  assert.match(expiry, /removeTrustedRootFileMatching\(policy\.inputs\.claim_path/);
  assert.match(expiry, /removeTrustedRootFileMatching\(policy\.inputs\.old_pat_path/);
  assert.match(expiry, /removeTrustedRootFileMatching\(policy\.inputs\.replacement_service_path/);
  assert.ok(expiry.indexOf("writeLiveState") < expiry.indexOf("deleteCredentialEscrow"));
  const wrapper = readFileSync(path.join(ROOT, "infra", "systemd", "newme-deploy.sh"), "utf8");
  assert.match(wrapper, /credential-expire-prepared\)/);
  assert.match(wrapper, /credential_live_exec expire-prepared/);
  assert.match(wrapper, /credential_live_state=EXPIRED/);
});

test("signed evidence never contains the synthetic credential values", () => {
  const policy = policyFixture();
  const serialized = JSON.stringify(signedPrecheck(policy));
  for (const kind of ["old_pat", "management_reader", "old_service", "replacement_service"]) {
    const syntheticValue = `synthetic-${kind}-credential-value-never-persisted`;
    assert.equal(serialized.includes(syntheticValue), false);
    assert.equal(serialized.includes(Buffer.from(syntheticValue).toString("base64")), false);
    assert.equal(serialized.includes(Buffer.from(syntheticValue).toString("base64url")), false);
  }
});
