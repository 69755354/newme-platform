#!/usr/bin/env node

import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  chownSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY_VERSION = "newme-credential-live-attestation-policy/v1";
export const CLAIM_VERSION = "newme-credential-live-claim/v1";
export const PRECHECK_VERSION = "newme-credential-live-precheck/v1";
export const REVOCATION_PROOF_VERSION = "newme-credential-live-revocation-proof/v1";
export const COMPLETION_VERSION = "newme-credential-live-completion/v1";
export const READBACK_VERSION = "newme-credential-live-readback/v1";
export const TOMBSTONE_VERSION = "newme-credential-live-consumed/v1";
export const RECEIPT_VERSION = "newme-credential-live-receipt/v1";
export const PROVIDER_IDENTITY_RECEIPT_VERSION = "newme-credential-provider-identity-receipt/v1";
export const SIGNATURE_DOMAIN = "newme-credential-live-attestation-signature/v1";
export const FINGERPRINT_DOMAIN = "newme-credential-fingerprint/v1";
export const POLICY_PATH = "infra/release/credential-live-attestation-policy-v1.json";
export const INSTALLED_POLICY_PATH = "/usr/local/share/newme/credential-live-attestation-policy-v1.json";
export const INSTALLED_HELPER_PATH = "/usr/local/libexec/newme/newme-credential-live-attestation.mjs";
export const PROTECTION_MARKER_PATH = "/var/lib/newme/deploy-state/credential-remediation.protected.json";
export const RUNTIME_ENV_PATH = "/etc/newme/newme-runtime.env";
const TRANSITION_PENDING_PATH = "/var/lib/newme/deploy-state/credential-transition.pending.json";
const TRANSITION_BACKUP_PATH = "/var/lib/newme/deploy-state/credential-transition.previous.env";
const TRANSITION_LAST_PATH = "/var/lib/newme/deploy-state/credential-transition.last.json";
const TRANSITION_HELPER_PATH = "/usr/local/libexec/newme/newme-credential-transition.mjs";
const CANONICAL_RELEASE_MIRROR = "/opt/newme/repository.git";
const PROVIDER_MATERIALIZATION_INTENT_PATH =
  "/var/lib/newme/deploy-state/credential-provider-materialization.intent.json";
const PROVIDER_MATERIALIZATION_INTENT_VERSION = "newme-credential-provider-materialization-intent/v1";

export const PROTECTED_CONTROL_PLANE_ASSETS = Object.freeze({
  "/etc/systemd/system/newme-platform.service": 0o644,
  "/etc/tmpfiles.d/newme-credential-inbox.conf": 0o644,
  "/etc/cron.d/newme-observability": 0o644,
  "/usr/local/sbin/newme-deploy": 0o755,
  "/usr/local/sbin/newme-production-rollback": 0o755,
  "/usr/local/libexec/newme/newme-install-systemd-assets": 0o755,
  "/usr/local/libexec/newme/newme-rollback-systemd-assets": 0o755,
  "/usr/local/libexec/newme/newme-validate-production-config.py": 0o755,
  "/usr/local/libexec/newme/newme-credential-transition.mjs": 0o755,
  "/usr/local/libexec/newme/newme-credential-live-attestation.mjs": 0o755,
  "/usr/local/share/newme/credential-live-attestation-policy-v1.json": 0o644,
  "/usr/local/libexec/newme/newme-readiness.sh": 0o755,
  "/opt/hermes-scripts/observability/dependency-probe.sh": 0o755,
});

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ZERO_SHA256 = "0".repeat(64);

export class CredentialLiveError extends Error {
  constructor(code) {
    super(code);
    this.name = "CredentialLiveError";
    this.code = code;
  }
}

function refuse(code) {
  throw new CredentialLiveError(code);
}

function requireTrustedRootAncestors(target, label) {
  const resolved = path.resolve(target);
  if (!path.isAbsolute(target) || resolved !== target) refuse(`${label}_path_invalid`);
  const parsed = path.parse(resolved);
  const directory = path.dirname(resolved);
  const parts = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let metadata;
    try { metadata = lstatSync(current, { bigint: true }); } catch { refuse(`${label}_ancestor_missing`); }
    if (
      !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0n || metadata.gid !== 0n ||
      (metadata.mode & 0o022n) !== 0n
    ) refuse(`${label}_ancestor_untrusted`);
  }
}

function readTrustedRootFile(file, { maximum, modes, label }) {
  requireTrustedRootAncestors(file, label);
  let before;
  try { before = lstatSync(file, { bigint: true }); } catch { refuse(`${label}_missing`); }
  if (
    !before.isFile() || before.isSymbolicLink() || before.uid !== 0n || before.gid !== 0n ||
    !modes.includes(Number(before.mode & 0o777n)) || before.nlink !== 1n ||
    before.size <= 0n || before.size > BigInt(maximum)
  ) refuse(`${label}_metadata_invalid`);
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() || opened.uid !== 0n || opened.gid !== 0n || opened.nlink !== 1n ||
      opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs
    ) refuse(`${label}_changed`);
    const bytes = readFileSync(descriptor);
    const after = lstatSync(file, { bigint: true });
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
    ) {
      refuse(`${label}_changed`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof CredentialLiveError) throw error;
    refuse(`${label}_read_failed`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireTrustedRootDirectory(directory, { modes, label }) {
  requireTrustedRootAncestors(path.join(directory, ".trusted-directory-leaf"), label);
  let metadata;
  try { metadata = lstatSync(directory); } catch { refuse(`${label}_missing`); }
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.gid !== 0 ||
    !modes.includes(metadata.mode & 0o777) || (metadata.mode & 0o022) !== 0
  ) refuse(`${label}_metadata_invalid`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!object(value)) refuse(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) refuse(code);
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) refuse("canonical_json_invalid");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        refuse("canonical_json_invalid");
      }
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!object(value)) refuse("canonical_json_invalid");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalCredentialJsonBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), "utf8");
}

function sameCanonicalJson(left, right) {
  return canonicalCredentialJsonBytes(left).equals(canonicalCredentialJsonBytes(right));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonBytes(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse(code);
  }
}

function parseSingleLineSecret(bytes, code) {
  const value = bytes.toString("utf8").replace(/\r?\n$/, "");
  if (!/^[A-Za-z0-9._-]{20,4096}$/.test(value)) refuse(code);
  return Buffer.from(value, "utf8");
}

function parseRuntimeServiceKey(bytes) {
  const values = [];
  for (const rawLine of bytes.toString("utf8").replace(/\r\n/g, "\n").split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== "SUPABASE_SERVICE_ROLE_KEY") continue;
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["\"", "'"].includes(value[0])) value = value.slice(1, -1);
    if (!/^[A-Za-z0-9._-]{20,2048}$/.test(value)) refuse("runtime_service_key_invalid");
    values.push(value);
  }
  if (values.length !== 1) refuse(values.length === 0 ? "runtime_service_key_missing" : "runtime_service_key_duplicate");
  return Buffer.from(values[0], "utf8");
}

function renderRuntimeServiceKey(runtimeBytes, replacementService) {
  const assignmentPattern = /^[\t ]*(?:export[\t ]+)?SUPABASE_SERVICE_ROLE_KEY[\t ]*=/;
  const lines = runtimeBytes.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  const retained = lines.filter((line) => !assignmentPattern.test(line));
  const base = retained.join("\n").replace(/\n+$/u, "");
  const assignment = `SUPABASE_SERVICE_ROLE_KEY=${replacementService.toString("utf8")}`;
  return Buffer.from(`${base}${base ? "\n" : ""}${assignment}\n`, "utf8");
}

export function validateInstalledProtectionMarker(markerBytes, { assetBytesByPath }) {
  const marker = parseJsonBytes(markerBytes, "protected_marker_invalid");
  exactKeys(marker, ["version", "candidate_sha", "activated_at", "assets"], "protected_marker_invalid");
  if (
    marker.version !== 2 || !SHA40.test(marker.candidate_sha) ||
    typeof marker.activated_at !== "string" || !TIMESTAMP.test(marker.activated_at) ||
    !object(marker.assets)
  ) refuse("protected_marker_invalid");
  const expectedPaths = Object.keys(PROTECTED_CONTROL_PLANE_ASSETS).sort();
  if (JSON.stringify(Object.keys(marker.assets).sort()) !== JSON.stringify(expectedPaths)) {
    refuse("protected_marker_asset_set_invalid");
  }
  for (const assetPath of expectedPaths) {
    assertSha256(marker.assets[assetPath], "protected_marker_asset_digest_invalid");
    const bytes = assetBytesByPath[assetPath];
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== marker.assets[assetPath]) {
      refuse("protected_marker_asset_digest_mismatch");
    }
  }
  return { marker, sha256: sha256(markerBytes) };
}

function endpointContractSha256(policy, kind) {
  const contract = kind === "service"
    ? {
        kind,
        method: "GET",
        origin: policy.supabase_data_origin,
        path: policy.service_probe_path,
        redirect: "error",
        user_agent: policy.user_agent,
      }
    : kind === "pat"
      ? {
          kind,
          method: "GET",
          origin: policy.supabase_management_origin,
          path: policy.management_probe_path,
          redirect: "error",
          user_agent: policy.user_agent,
        }
      : null;
  if (contract === null) refuse("endpoint_contract_kind_invalid");
  return sha256(canonicalCredentialJsonBytes(contract));
}

export function credentialEndpointContractSha256(policy, kind) {
  validateCredentialLivePolicy(policy);
  return endpointContractSha256(policy, kind);
}

export function providerIdentityEndpointContractSha256(policy, providerObjectId) {
  validateCredentialLivePolicy(policy);
  assertNonSecretProviderId(providerObjectId, "credential_provider_id_invalid");
  return sha256(canonicalCredentialJsonBytes({
    kind: "provider_identity",
    method: "GET",
    origin: policy.supabase_management_origin,
    path: `${policy.provider_keys_path}/${providerObjectId}`,
    query: { reveal: "true" },
    redirect: "manual",
    user_agent: policy.user_agent,
  }));
}

function timestampMs(value, code) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) refuse(code);
  const result = Date.parse(value);
  if (!Number.isFinite(result)) refuse(code);
  return result;
}

function boundedTimestamp(value, { nowMs, oldestMs, newestMs = nowMs + 60_000 }, code) {
  const parsed = timestampMs(value, code);
  if (parsed < oldestMs || parsed > newestMs) refuse(code);
  return parsed;
}

function validateProviderObservation(observedAt, providerDate, {
  nowMs,
  oldestMs,
  newestMs = nowMs,
}, code) {
  const observed = boundedTimestamp(observedAt, { nowMs, oldestMs, newestMs }, code);
  if (typeof providerDate !== "string") refuse(code);
  const provider = Date.parse(providerDate);
  if (
    !Number.isFinite(provider) || new Date(provider).toUTCString() !== providerDate ||
    provider > nowMs + 60_000 || Math.abs(provider - observed) > 120_000
  ) refuse(code);
  return observed;
}

function assertSha256(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) refuse(code);
}

function assertSafeId(value, code) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) refuse(code);
}

function assertNonSecretProviderId(value, code) {
  assertSafeId(value, code);
  if (
    /^(?:sbp_|sb_secret_|sb_publishable_|eyJ|ghp_|github_pat_)/.test(value) ||
    (!UUID.test(value) && /^[A-Za-z0-9_-]{32,}$/.test(value)) ||
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  ) refuse(code);
}

function validateConsumerPolicy(value) {
  exactKeys(value, ["id", "kind", "path"], "policy_consumer_shape_invalid");
  assertSafeId(value.id, "policy_consumer_id_invalid");
  if (!["supabase_service_role_read", "root_command"].includes(value.kind)) {
    refuse("policy_consumer_kind_invalid");
  }
  if (typeof value.path !== "string" || !value.path.startsWith("/")) {
    refuse("policy_consumer_path_invalid");
  }
}

export function validateCredentialLivePolicy(policy) {
  exactKeys(policy, [
    "version", "repository", "project_ref", "github_api_origin",
    "supabase_management_origin", "supabase_data_origin", "github_api_version",
    "workflow", "fingerprints", "credential_identities", "receipts", "inputs", "state",
    "service_probe_path", "management_probe_path", "provider_keys_path",
    "expected_alerts", "required_consumers", "precheck_ttl_seconds", "escrow_ttl_seconds",
    "completion_max_age_seconds", "live_readback_ttl_seconds",
    "max_response_bytes", "max_pages", "request_timeout_ms", "user_agent",
  ], "policy_shape_invalid");
  if (policy.version !== POLICY_VERSION) refuse("policy_version_invalid");
  if (policy.repository !== "69755354/newme-platform") refuse("policy_repository_invalid");
  if (policy.project_ref !== "vfopmpxlhwzpxqegayew") refuse("policy_project_invalid");
  if (policy.github_api_origin !== "https://api.github.com") refuse("policy_github_origin_invalid");
  if (policy.supabase_management_origin !== "https://api.supabase.com") refuse("policy_management_origin_invalid");
  if (policy.supabase_data_origin !== "https://vfopmpxlhwzpxqegayew.supabase.co") refuse("policy_data_origin_invalid");
  if (policy.github_api_version !== "2026-03-10") refuse("policy_github_version_invalid");

  exactKeys(policy.workflow, ["id", "path", "event", "head_branch", "max_age_seconds"], "policy_workflow_invalid");
  if (
    policy.workflow.id !== 310914082 ||
    policy.workflow.path !== ".github/workflows/ci.yml" ||
    policy.workflow.event !== "workflow_dispatch" ||
    policy.workflow.head_branch !== "main" ||
    !Number.isInteger(policy.workflow.max_age_seconds) ||
    policy.workflow.max_age_seconds < 1 || policy.workflow.max_age_seconds > 21600
  ) refuse("policy_workflow_invalid");

  exactKeys(policy.fingerprints, ["version", "algorithm", "key_id", "key_path"], "policy_fingerprint_invalid");
  if (
    policy.fingerprints.version !== FINGERPRINT_DOMAIN ||
    policy.fingerprints.algorithm !== "HMAC-SHA256" ||
    policy.fingerprints.key_id !== "newme-production-credential-fingerprint-2026-08-v1" ||
    policy.fingerprints.key_path !== "/etc/newme/credential-attestation-hmac.key"
  ) refuse("policy_fingerprint_invalid");

  exactKeys(
    policy.credential_identities,
    ["old_pat", "management_reader", "old_service", "replacement_service"],
    "policy_credential_identities_invalid",
  );
  for (const kind of ["old_pat", "management_reader", "old_service", "replacement_service"]) {
    const identity = policy.credential_identities[kind];
    exactKeys(identity, ["provider_object_id", "scope_id", "provider_kind"], "policy_credential_identities_invalid");
    assertNonSecretProviderId(identity.provider_object_id, "policy_credential_identities_invalid");
    assertSafeId(identity.scope_id, "policy_credential_identities_invalid");
    if (identity.provider_object_id === "UNSTAMPED" || identity.scope_id === "UNSTAMPED" || identity.provider_kind === "UNSTAMPED") {
      refuse("policy_credential_identities_unstamped");
    }
    const allowedKinds = kind === "old_service" || kind === "replacement_service"
      ? ["secret", "legacy_service_role"]
      : ["pat"];
    if (!allowedKinds.includes(identity.provider_kind)) refuse("policy_credential_kind_invalid");
  }
  const projectScope = `project-${policy.project_ref}`;
  for (const kind of ["management_reader", "old_service", "replacement_service"]) {
    if (policy.credential_identities[kind].scope_id !== projectScope) {
      refuse("policy_credential_scope_invalid");
    }
  }

  exactKeys(policy.receipts, [
    "version", "algorithm", "private_key_path", "public_key_path",
    "public_key_file_sha256", "public_key_spki_sha256",
  ], "policy_receipt_invalid");
  if (
    policy.receipts.version !== RECEIPT_VERSION ||
    policy.receipts.algorithm !== "Ed25519" ||
    policy.receipts.private_key_path !== "/etc/newme/postdeploy-acceptance-receipt.key" ||
    policy.receipts.public_key_path !== "/etc/newme/postdeploy-acceptance-receipt.pub" ||
    !SHA256.test(policy.receipts.public_key_file_sha256) ||
    !SHA256.test(policy.receipts.public_key_spki_sha256) ||
    policy.receipts.public_key_file_sha256 === ZERO_SHA256 ||
    policy.receipts.public_key_spki_sha256 === ZERO_SHA256
  ) refuse("policy_receipt_trust_root_unstamped");

  exactKeys(policy.inputs, [
    "claim_path", "provider_identity_receipt_path", "old_pat_path", "replacement_service_path", "management_reader_path",
    "github_reader_path", "github_secret_scanning_reader_path",
  ], "policy_inputs_invalid");
  const expectedInputs = {
    claim_path: "/run/newme-credential-live-input/credential-live-claim.json",
    provider_identity_receipt_path: "/run/newme-credential-live-input/provider-identity-receipt.json",
    old_pat_path: "/run/newme-credential-live-input/supabase-old-pat.token",
    replacement_service_path: "/run/newme-credential-inbox/supabase-service-key.env",
    management_reader_path: "/etc/newme/supabase-management-read.token",
    github_reader_path: "/etc/newme/github-actions-read.token",
    github_secret_scanning_reader_path: "/etc/newme/github-secret-scanning-read.token",
  };
  if (!sameCanonicalJson(policy.inputs, expectedInputs)) refuse("policy_inputs_invalid");

  exactKeys(policy.state, [
    "precheck_path", "revocation_proof_path", "completion_path", "live_readback_path", "consumed_path",
    "journal_path", "escrow_directory",
  ], "policy_state_invalid");
  const statePaths = Object.values(policy.state);
  if (
    new Set(statePaths).size !== statePaths.length ||
    statePaths.some((value) => typeof value !== "string" || !value.startsWith("/var/lib/newme/deploy-state/")) ||
    policy.state.journal_path !== "/var/lib/newme/deploy-state/credential-remediation.live-state.json" ||
    policy.state.escrow_directory !== "/var/lib/newme/deploy-state/credential-remediation-live-escrow"
  ) refuse("policy_state_invalid");
  if (policy.service_probe_path !== "/auth/v1/admin/users?page=1&per_page=1") refuse("policy_service_probe_invalid");
  if (policy.management_probe_path !== `/v1/projects/${policy.project_ref}`) refuse("policy_management_probe_invalid");
  if (policy.provider_keys_path !== `/v1/projects/${policy.project_ref}/api-keys`) refuse("policy_provider_keys_invalid");

  if (
    !Array.isArray(policy.expected_alerts) ||
    !sameCanonicalJson(policy.expected_alerts, [
      { number: 1, secret_type: "supabase_personal_access_token" },
      { number: 2, secret_type: "supabase_secret_key" },
    ])
  ) refuse("policy_alerts_invalid");
  if (!Array.isArray(policy.required_consumers) || policy.required_consumers.length !== 3) {
    refuse("policy_consumers_invalid");
  }
  policy.required_consumers.forEach(validateConsumerPolicy);
  if (new Set(policy.required_consumers.map((item) => item.id)).size !== 3) refuse("policy_consumers_invalid");
  if (
    policy.required_consumers[0].id !== "service_role_auth_admin_read" ||
    policy.required_consumers[0].kind !== "supabase_service_role_read" ||
    policy.required_consumers[0].path !== policy.service_probe_path
  ) refuse("policy_consumers_invalid");
  const commandConsumers = Object.fromEntries(policy.required_consumers.slice(1).map((item) => [item.id, item.path]));
  if (
    commandConsumers.application_readiness !== "/usr/local/libexec/newme/newme-readiness.sh" ||
    commandConsumers.dependency_probe !== "/opt/hermes-scripts/observability/dependency-probe.sh"
  ) refuse("policy_consumers_invalid");

  for (const [key, maximum] of [
    ["precheck_ttl_seconds", 900],
    ["escrow_ttl_seconds", 21_600],
    ["completion_max_age_seconds", 31_536_000],
    ["live_readback_ttl_seconds", 900],
    ["max_response_bytes", 1_048_576],
    ["max_pages", 20],
    ["request_timeout_ms", 20_000],
  ]) {
    if (!Number.isInteger(policy[key]) || policy[key] < 1 || policy[key] > maximum) refuse("policy_limits_invalid");
  }
  if (policy.user_agent !== "newme-credential-attestation/1") refuse("policy_user_agent_invalid");
  return structuredClone(policy);
}

export function policySha256(policy) {
  validateCredentialLivePolicy(policy);
  return sha256(canonicalCredentialJsonBytes(policy));
}

export function credentialFingerprint({ keyBytes, keyId, transactionId, nonce, kind, secretBytes }) {
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length < 32) refuse("fingerprint_key_invalid");
  if (keyId !== "newme-production-credential-fingerprint-2026-08-v1") refuse("fingerprint_key_id_invalid");
  if (!UUID.test(transactionId) || !NONCE.test(nonce)) refuse("fingerprint_context_invalid");
  if (!["old_pat", "management_reader", "old_service", "replacement_service"].includes(kind)) {
    refuse("fingerprint_kind_invalid");
  }
  const bytes = Buffer.isBuffer(secretBytes) ? secretBytes : Buffer.from(secretBytes ?? "", "utf8");
  if (bytes.length < 20 || bytes.length > 4096) refuse("fingerprint_secret_invalid");
  return createHmac("sha256", keyBytes)
    .update(`${FINGERPRINT_DOMAIN}\0${keyId}\0${transactionId}\0${nonce}\0${kind}\0`, "utf8")
    .update(bytes)
    .digest("base64url");
}

function receiptInput(document) {
  const unsigned = structuredClone(document);
  if (!object(unsigned.receipt)) refuse("receipt_shape_invalid");
  unsigned.receipt.signature = "";
  return Buffer.concat([
    Buffer.from(`${SIGNATURE_DOMAIN}\0${document.purpose}\0`, "utf8"),
    canonicalCredentialJsonBytes(unsigned),
  ]);
}

function publicKeyDigests(publicKeyBytes) {
  let key;
  try { key = createPublicKey(publicKeyBytes); } catch { refuse("receipt_public_key_invalid"); }
  if (key.asymmetricKeyType !== "ed25519") refuse("receipt_public_key_invalid");
  return {
    file: sha256(publicKeyBytes),
    spki: sha256(key.export({ type: "spki", format: "der" })),
  };
}

export function signCredentialEvidence({
  document,
  privateKeyBytes,
  publicKeyBytes,
  signedAt,
  secretLeakGuard,
}) {
  if (!object(document) || Object.hasOwn(document, "receipt")) refuse("evidence_shape_invalid");
  if (!["provider_identity", "precheck", "revocation_proof", "completion", "readback", "tombstone"].includes(document.purpose)) refuse("evidence_purpose_invalid");
  const allowedTopLevel = {
    provider_identity: [
      "version", "purpose", "policy_sha256", "claim_sha256", "candidate_sha",
      "transaction_id", "nonce", "credentials", "provider_binding", "issued_at", "expires_at",
    ],
    precheck: [
      "version", "purpose", "transaction_id", "nonce", "policy_sha256", "claim_sha256",
      "candidate_sha", "ci", "transition_before_sha256", "credentials", "positive_controls",
      "protected_assets_sha256", "pre_cutover_invocation_id", "github", "supabase",
      "issued_at", "expires_at",
    ],
    revocation_proof: [
      "version", "purpose", "transaction_id", "nonce", "policy_sha256", "candidate_sha",
      "ci", "precheck_sha256", "transition", "credentials", "github", "supabase",
      "sandwiches", "protected_assets_sha256", "pre_cutover_invocation_id",
      "post_cutover_invocation_id", "consumers", "issued_at", "expires_at",
    ],
    completion: [
      "version", "purpose", "transaction_id", "nonce", "policy_sha256", "candidate_sha",
      "ci", "precheck_sha256", "transition", "credentials", "github", "supabase",
      "sandwiches", "protected_assets_sha256", "pre_cutover_invocation_id",
      "post_cutover_invocation_id", "consumers", "revocation_proof",
      "issued_at", "expires_at",
    ],
    readback: [
      "version", "purpose", "transaction_id", "nonce", "policy_sha256", "completion_sha256",
      "remediation_sha", "release_sha", "ci", "claim", "precheck", "github", "supabase",
      "sandwiches", "protected_assets_sha256", "post_cutover_invocation_id", "service_probe",
      "consumers", "relation", "observed_at", "expires_at",
    ],
    tombstone: [
      "version", "purpose", "state", "transaction_id", "nonce", "candidate_sha", "release_sha",
      "ci_run_id", "ci_run_attempt", "transition_last_sha256", "completion_sha256",
      "readback_sha256", "consumed_at",
    ],
  };
  exactKeys(document, allowedTopLevel[document.purpose], "evidence_shape_invalid");
  exactKeys(
    secretLeakGuard,
    ["old_pat", "management_reader", "old_service", "replacement_service"],
    "secret_leak_guard_missing",
  );
  const forbiddenSecretBytes = Object.values(secretLeakGuard);
  if (forbiddenSecretBytes.some((candidate) => !Buffer.isBuffer(candidate))) {
    refuse("secret_leak_guard_invalid");
  }
  for (let left = 0; left < forbiddenSecretBytes.length; left += 1) {
    for (let right = left + 1; right < forbiddenSecretBytes.length; right += 1) {
      if (forbiddenSecretBytes[left].equals(forbiddenSecretBytes[right])) {
        refuse("secret_leak_guard_invalid");
      }
    }
  }
  const serialized = canonicalCredentialJsonBytes(document).toString("utf8");
  for (const candidate of forbiddenSecretBytes) {
    const bytes = candidate;
    if (bytes.length < 8) refuse("secret_leak_guard_invalid");
    const raw = bytes.toString("utf8");
    for (const encoded of [
      raw,
      encodeURIComponent(raw),
      bytes.toString("hex"),
      bytes.toString("base64"),
      bytes.toString("base64url"),
    ]) {
      if (encoded && serialized.includes(encoded)) refuse("secret_material_in_evidence");
    }
  }
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyBytes); } catch { refuse("receipt_private_key_invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") refuse("receipt_private_key_invalid");
  const keyDigests = publicKeyDigests(publicKeyBytes);
  const signed = {
    ...structuredClone(document),
    receipt: {
      version: RECEIPT_VERSION,
      algorithm: "Ed25519",
      domain: `${SIGNATURE_DOMAIN}/${document.purpose}`,
      public_key_file_sha256: keyDigests.file,
      public_key_spki_sha256: keyDigests.spki,
      signed_at: signedAt,
      signature: "",
    },
  };
  signed.receipt.signature = signBytes(null, receiptInput(signed), privateKey).toString("base64url");
  if (!verifyBytes(
    null,
    receiptInput(signed),
    createPublicKey(publicKeyBytes),
    Buffer.from(signed.receipt.signature, "base64url"),
  )) refuse("receipt_key_pair_mismatch");
  return signed;
}

export function verifyCredentialEvidenceReceipt({ document, publicKeyBytes, policy, nowMs = Date.now() }) {
  validateCredentialLivePolicy(policy);
  exactKeys(document.receipt, [
    "version", "algorithm", "domain", "public_key_file_sha256", "public_key_spki_sha256",
    "signed_at", "signature",
  ], "receipt_shape_invalid");
  const actualKeyDigests = publicKeyDigests(publicKeyBytes);
  if (
    policy.receipts.public_key_file_sha256 !== actualKeyDigests.file ||
    policy.receipts.public_key_spki_sha256 !== actualKeyDigests.spki ||
    document.receipt.public_key_file_sha256 !== actualKeyDigests.file ||
    document.receipt.public_key_spki_sha256 !== actualKeyDigests.spki ||
    document.receipt.version !== RECEIPT_VERSION ||
    document.receipt.algorithm !== "Ed25519" ||
    document.receipt.domain !== `${SIGNATURE_DOMAIN}/${document.purpose}`
  ) refuse("receipt_trust_binding_invalid");
  boundedTimestamp(document.receipt.signed_at, {
    nowMs,
    oldestMs: nowMs - policy.completion_max_age_seconds * 1000,
  }, "receipt_timestamp_invalid");
  if (typeof document.receipt.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(document.receipt.signature)) {
    refuse("receipt_signature_invalid");
  }
  let signature;
  try { signature = Buffer.from(document.receipt.signature, "base64url"); } catch { refuse("receipt_signature_invalid"); }
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== document.receipt.signature ||
    !verifyBytes(null, receiptInput(document), createPublicKey(publicKeyBytes), signature)
  ) {
    refuse("receipt_signature_invalid");
  }
  return actualKeyDigests;
}

function validateCi(ci, policy, { expectedSha, expectedRun, expectedAttempt, nowMs }) {
  exactKeys(ci, [
    "workflow_id", "workflow_path", "event", "head_branch", "run_id", "run_attempt",
    "head_sha", "status", "conclusion", "completed_at", "verified_at", "requests",
  ], "ci_shape_invalid");
  if (
    ci.workflow_id !== policy.workflow.id || ci.workflow_path !== policy.workflow.path ||
    ci.event !== policy.workflow.event || ci.head_branch !== policy.workflow.head_branch ||
    ci.run_id !== String(expectedRun) || ci.run_attempt !== expectedAttempt ||
    ci.head_sha !== expectedSha || ci.status !== "completed" || ci.conclusion !== "success"
  ) refuse("ci_identity_invalid");
  const completed = boundedTimestamp(ci.completed_at, {
    nowMs,
    oldestMs: nowMs - policy.workflow.max_age_seconds * 1000,
  }, "ci_freshness_invalid");
  const verified = boundedTimestamp(ci.verified_at, {
    nowMs,
    oldestMs: completed,
  }, "ci_freshness_invalid");
  if (verified < completed) refuse("ci_freshness_invalid");
  if (!Array.isArray(ci.requests) || ci.requests.length !== 2) refuse("ci_request_transcript_invalid");
  const operations = ["run", "workflow"];
  let previousObserved = completed;
  const requestIds = new Set();
  ci.requests.forEach((request, index) => {
    exactKeys(request, ["operation", "status", "observed_at", "provider_date", "request_id"], "ci_request_transcript_invalid");
    if (
      request.operation !== operations[index] || request.status !== 200 ||
      !SAFE_ID.test(request.request_id) || requestIds.has(request.request_id)
    ) refuse("ci_request_transcript_invalid");
    requestIds.add(request.request_id);
    previousObserved = validateProviderObservation(request.observed_at, request.provider_date, {
      nowMs: verified,
      oldestMs: previousObserved,
      newestMs: verified,
    }, "ci_request_transcript_invalid");
  });
  if (ci.requests[1].observed_at !== ci.verified_at) refuse("ci_request_transcript_invalid");
}

function parseTransitionLastRecord(transitionLastBytes) {
  let transition;
  try {
    transition = JSON.parse(Buffer.isBuffer(transitionLastBytes)
      ? transitionLastBytes.toString("utf8")
      : String(transitionLastBytes));
  } catch {
    refuse("completion_transition_invalid");
  }
  const awaitingKeys = [
    "version", "status", "transaction_id", "precheck_sha256", "candidate_sha",
    "ci_run_id", "ci_run_attempt", "finished_at", "before_sha256", "after_sha256",
  ];
  const completeKeys = [
    ...awaitingKeys,
    "awaiting_last_sha256", "completion_sha256", "finalized_at",
  ];
  const complete = transition?.status === "complete";
  exactKeys(transition, complete ? completeKeys : awaitingKeys, "completion_transition_invalid");
  if (
    transition.version !== 1 || !["awaiting_provider_revocation", "complete"].includes(transition.status) ||
    !UUID.test(transition.transaction_id) || !SHA256.test(transition.precheck_sha256) ||
    !SHA40.test(transition.candidate_sha) || typeof transition.ci_run_id !== "string" || !RUN_ID.test(transition.ci_run_id) ||
    !Number.isInteger(transition.ci_run_attempt) || transition.ci_run_attempt < 1 ||
    !TIMESTAMP.test(transition.finished_at) || !SHA256.test(transition.before_sha256) ||
    !SHA256.test(transition.after_sha256) || transition.before_sha256 === transition.after_sha256
  ) refuse("completion_transition_invalid");
  const evidence = {
    version: transition.version,
    status: "awaiting_provider_revocation",
    transaction_id: transition.transaction_id,
    precheck_sha256: transition.precheck_sha256,
    candidate_sha: transition.candidate_sha,
    ci_run_id: transition.ci_run_id,
    ci_run_attempt: transition.ci_run_attempt,
    finished_at: transition.finished_at,
    before_sha256: transition.before_sha256,
    after_sha256: transition.after_sha256,
  };
  const evidenceBytes = complete
    ? Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8")
    : Buffer.isBuffer(transitionLastBytes)
      ? Buffer.from(transitionLastBytes)
      : Buffer.from(String(transitionLastBytes), "utf8");
  if (complete && (
    !SHA256.test(transition.awaiting_last_sha256) ||
    !SHA256.test(transition.completion_sha256) ||
    !TIMESTAMP.test(transition.finalized_at) ||
    sha256(evidenceBytes) !== transition.awaiting_last_sha256
  )) refuse("completion_transition_invalid");
  return { transition: evidence, evidenceBytes, completeRecord: complete ? transition : null };
}

function parseTransitionLast(transitionLastBytes) {
  return parseTransitionLastRecord(transitionLastBytes).transition;
}

function validateAlertProjection(alert, expected, requiredState) {
  exactKeys(alert, ["number", "secret_type", "state", "resolution", "resolved_at", "publicly_leaked"], "github_alert_shape_invalid");
  if (alert.number !== expected.number || alert.secret_type !== expected.secret_type || alert.publicly_leaked !== true) {
    refuse("github_alert_identity_invalid");
  }
  if (requiredState === "open") {
    if (alert.state !== "open" || alert.resolution !== null || alert.resolved_at !== null) refuse("github_alert_not_open");
  } else if (
    alert.state !== "resolved" || alert.resolution !== "revoked" ||
    typeof alert.resolved_at !== "string" || !TIMESTAMP.test(alert.resolved_at)
  ) refuse("github_alert_not_revoked");
}

export function validateGithubEvidence(github, policy, {
  requiredState,
  nowMs,
  notBeforeMs = nowMs - policy.live_readback_ttl_seconds * 1000,
  resolvedNotBeforeMs = notBeforeMs,
}) {
  exactKeys(github, [
    "repository", "api_version", "hide_secret", "pages_read", "pagination_complete", "open_count",
    "alerts", "requests", "observed_at", "provider_date", "request_id",
  ], "github_evidence_shape_invalid");
  if (
    github.repository !== policy.repository || github.api_version !== policy.github_api_version ||
    github.hide_secret !== true || !Number.isInteger(github.pages_read) || github.pages_read < 1 ||
    github.pages_read > policy.max_pages || github.pagination_complete !== true ||
    !Number.isInteger(github.open_count) || github.open_count < 0 ||
    !Array.isArray(github.alerts) || github.alerts.length !== policy.expected_alerts.length ||
    !Array.isArray(github.requests) ||
    !SAFE_ID.test(github.request_id)
  ) refuse("github_evidence_invalid");
  const expectedOperations = [
    ...policy.expected_alerts.map((alert) => `alert-${alert.number}`),
    ...Array.from({ length: github.pages_read }, (_, index) => `open-page-${index + 1}`),
  ];
  if (github.requests.length !== expectedOperations.length) refuse("github_request_transcript_invalid");
  const requestIds = new Set();
  github.requests.forEach((request, index) => {
    exactKeys(request, ["operation", "status", "observed_at", "provider_date", "request_id", "link_sha256"], "github_request_transcript_invalid");
    if (
      request.operation !== expectedOperations[index] || request.status !== 200 ||
      !SAFE_ID.test(request.request_id) || requestIds.has(request.request_id) || !SHA256.test(request.link_sha256)
    ) refuse("github_request_transcript_invalid");
    requestIds.add(request.request_id);
    validateProviderObservation(request.observed_at, request.provider_date, {
      nowMs,
      oldestMs: notBeforeMs,
    }, "github_request_transcript_invalid");
  });
  policy.expected_alerts.forEach((expected, index) => validateAlertProjection(github.alerts[index], expected, requiredState));
  if (requiredState === "open" && github.open_count < policy.expected_alerts.length) {
    refuse("github_open_count_inconsistent");
  }
  if (requiredState === "resolved" && github.open_count !== 0) refuse("github_open_alerts_remain");
  const observed = validateProviderObservation(github.observed_at, github.provider_date, {
    nowMs,
    oldestMs: notBeforeMs,
  }, "github_evidence_stale");
  if (requiredState === "resolved") {
    for (const alert of github.alerts) {
      const resolved = timestampMs(alert.resolved_at, "github_alert_not_revoked");
      if (resolved < resolvedNotBeforeMs || resolved > observed + 60_000) refuse("github_alert_not_revoked");
    }
  }
}

function validateProviderIdentity(identity, label) {
  exactKeys(identity, ["provider_object_id", "kind", "scope_id", "present", "policy_identity_match"], `${label}_shape_invalid`);
  assertNonSecretProviderId(identity.provider_object_id, `${label}_id_invalid`);
  assertSafeId(identity.scope_id, `${label}_scope_invalid`);
  if (!new Set(["secret", "legacy_service_role"]).has(identity.kind)) refuse(`${label}_kind_invalid`);
  if (typeof identity.present !== "boolean" || typeof identity.policy_identity_match !== "boolean") refuse(`${label}_shape_invalid`);
}

export function validateSupabaseEvidence(supabase, policy, { stage, nowMs, credentials, notBeforeMs = nowMs - policy.live_readback_ttl_seconds * 1000 }) {
  exactKeys(supabase, ["project_ref", "reveal", "pagination_complete", "pages_read", "old_service", "replacement_service", "observed_at", "provider_date", "request_id"], "supabase_evidence_shape_invalid");
  if (
    supabase.project_ref !== policy.project_ref || supabase.reveal !== false ||
    supabase.pagination_complete !== true || !Number.isInteger(supabase.pages_read) ||
    supabase.pages_read < 1 || supabase.pages_read > policy.max_pages || !SAFE_ID.test(supabase.request_id)
  ) refuse("supabase_evidence_invalid");
  validateProviderIdentity(supabase.old_service, "old_service_provider");
  validateProviderIdentity(supabase.replacement_service, "replacement_service_provider");
  if (
    !object(credentials) ||
    supabase.old_service.provider_object_id !== credentials.old_service?.provider_object_id ||
    supabase.old_service.scope_id !== credentials.old_service?.scope_id ||
    supabase.old_service.kind !== policy.credential_identities.old_service.provider_kind ||
    supabase.replacement_service.provider_object_id !== credentials.replacement_service?.provider_object_id ||
    supabase.replacement_service.scope_id !== credentials.replacement_service?.scope_id ||
    supabase.replacement_service.kind !== policy.credential_identities.replacement_service.provider_kind
  ) refuse("supabase_provider_identity_unbound");
  if (supabase.old_service.provider_object_id === supabase.replacement_service.provider_object_id) {
    refuse("supabase_provider_identity_reused");
  }
  if (stage === "precheck") {
    if (!supabase.old_service.present || !supabase.old_service.policy_identity_match) refuse("old_service_provider_not_bound");
  } else if (supabase.old_service.present || supabase.old_service.policy_identity_match) {
    refuse("old_service_provider_still_present");
  }
  if (!supabase.replacement_service.present || !supabase.replacement_service.policy_identity_match) {
    refuse("replacement_service_provider_not_bound");
  }
  validateProviderObservation(supabase.observed_at, supabase.provider_date, {
    nowMs,
    oldestMs: notBeforeMs,
  }, "supabase_evidence_stale");
}

export function validateSandwich(sandwich, {
  kind,
  oldFingerprint,
  replacementFingerprint,
  policy,
  nowMs,
  notBeforeMs,
}) {
  exactKeys(sandwich, [
    "kind", "endpoint_contract_sha256", "old_fingerprint", "replacement_fingerprint",
    "steps", "started_at", "finished_at",
  ], "sandwich_shape_invalid");
  if (sandwich.kind !== kind) refuse("sandwich_kind_invalid");
  if (sandwich.endpoint_contract_sha256 !== endpointContractSha256(policy, kind)) {
    refuse("sandwich_endpoint_invalid");
  }
  if (sandwich.old_fingerprint !== oldFingerprint || sandwich.replacement_fingerprint !== replacementFingerprint) {
    refuse("sandwich_identity_invalid");
  }
  if (!Array.isArray(sandwich.steps) || sandwich.steps.length !== 3) refuse("sandwich_order_invalid");
  const expected = [
    ["replacement_before", 200, "success"],
    ["old", 401, kind === "service" ? "unregistered_api_key" : "unauthorized"],
    ["replacement_after", 200, "success"],
  ];
  sandwich.steps.forEach((step, index) => {
    exactKeys(step, ["credential", "status", "provider_code", "request_id", "observed_at", "provider_date"], "sandwich_step_shape_invalid");
    const [credential, status, providerCode] = expected[index];
    if (step.credential !== credential || step.status !== status || step.provider_code !== providerCode || !SAFE_ID.test(step.request_id)) {
      refuse("sandwich_result_invalid");
    }
  });
  if (new Set(sandwich.steps.map((step) => step.request_id)).size !== sandwich.steps.length) {
    refuse("sandwich_request_replayed");
  }
  const started = timestampMs(sandwich.started_at, "sandwich_time_invalid");
  const finished = timestampMs(sandwich.finished_at, "sandwich_time_invalid");
  if (
    started < notBeforeMs || started > finished || finished > nowMs + 60_000 ||
    finished < nowMs - policy.live_readback_ttl_seconds * 1000
  ) {
    refuse("sandwich_time_invalid");
  }
  let previous = started;
  for (const step of sandwich.steps) {
    const observed = validateProviderObservation(step.observed_at, step.provider_date, {
      nowMs: finished,
      oldestMs: previous,
      newestMs: finished,
    }, "sandwich_time_invalid");
    previous = observed;
  }
}

function validatePositiveControls(controls, policy, { credentials, nowMs, notBeforeMs }) {
  if (!Array.isArray(controls) || controls.length !== 4) refuse("positive_control_invalid");
  const expected = [
    ["old_pat", "pat"],
    ["management_reader", "pat"],
    ["old_service", "service"],
    ["replacement_service", "service"],
  ];
  const requestIds = new Set();
  controls.forEach((control, index) => {
    exactKeys(control, [
      "credential", "endpoint_contract_sha256", "fingerprint", "status",
      "provider_code", "request_id", "observed_at", "provider_date",
    ], "positive_control_shape_invalid");
    const [credential, endpointKind] = expected[index];
    if (
      control.credential !== credential ||
      control.endpoint_contract_sha256 !== endpointContractSha256(policy, endpointKind) ||
      control.fingerprint !== credentials[credential]?.fingerprint ||
      control.status !== 200 || control.provider_code !== "success" ||
      !SAFE_ID.test(control.request_id) || requestIds.has(control.request_id)
    ) refuse("positive_control_invalid");
    requestIds.add(control.request_id);
    validateProviderObservation(control.observed_at, control.provider_date, {
      nowMs,
      oldestMs: notBeforeMs,
    }, "positive_control_time_invalid");
  });
}

function consumerContractSha256(policy, consumer) {
  return sha256(canonicalCredentialJsonBytes({
    id: consumer.id,
    kind: consumer.kind,
    path: consumer.path,
    replacement_fingerprint_required: true,
  }));
}

function consumerEvidenceSha256(consumer) {
  return sha256(canonicalCredentialJsonBytes({
    id: consumer.id,
    kind: consumer.kind,
    path: consumer.path,
    status: consumer.status,
    transition_last_sha256: consumer.transition_last_sha256,
    invocation_id: consumer.invocation_id,
    replacement_fingerprint: consumer.replacement_fingerprint,
    protected_assets_sha256: consumer.protected_assets_sha256,
    contract_sha256: consumer.contract_sha256,
    observed_at: consumer.observed_at,
  }));
}

export function validateConsumers(consumers, policy, {
  transitionLastSha256,
  invocationId,
  replacementFingerprint,
  protectedAssetsSha256,
  nowMs,
  notBeforeMs,
}) {
  if (!Array.isArray(consumers) || consumers.length !== policy.required_consumers.length) refuse("consumer_evidence_invalid");
  consumers.forEach((consumer, index) => {
    exactKeys(consumer, [
      "id", "kind", "path", "status", "transition_last_sha256", "invocation_id",
      "replacement_fingerprint", "protected_assets_sha256", "contract_sha256",
      "observed_at", "evidence_sha256",
    ], "consumer_evidence_shape_invalid");
    const expected = policy.required_consumers[index];
    if (
      consumer.id !== expected.id || consumer.kind !== expected.kind || consumer.path !== expected.path ||
      consumer.status !== "pass" || consumer.transition_last_sha256 !== transitionLastSha256 ||
      consumer.invocation_id !== invocationId ||
      consumer.replacement_fingerprint !== replacementFingerprint ||
      consumer.protected_assets_sha256 !== protectedAssetsSha256 ||
      consumer.contract_sha256 !== consumerContractSha256(policy, expected)
    ) refuse("consumer_evidence_invalid");
    if (consumer.evidence_sha256 !== consumerEvidenceSha256(consumer)) {
      refuse("consumer_evidence_invalid");
    }
    boundedTimestamp(consumer.observed_at, { nowMs, oldestMs: notBeforeMs }, "consumer_evidence_invalid");
  });
}

function validateFingerprintSet(credentials, policy) {
  exactKeys(credentials, ["old_pat", "management_reader", "old_service", "replacement_service"], "credential_identity_shape_invalid");
  for (const [kind, value] of Object.entries(credentials)) {
    exactKeys(value, ["kind", "fingerprint", "provider_object_id", "scope_id"], "credential_identity_shape_invalid");
    if (value.kind !== kind || !/^[A-Za-z0-9_-]{43}$/.test(value.fingerprint)) refuse("credential_fingerprint_invalid");
    assertNonSecretProviderId(value.provider_object_id, "credential_provider_id_invalid");
    assertSafeId(value.scope_id, "credential_scope_invalid");
  }
  if (new Set(Object.values(credentials).map((item) => item.fingerprint)).size !== 4) {
    refuse("credential_fingerprint_reused");
  }
  for (const kind of ["old_pat", "management_reader", "old_service", "replacement_service"]) {
    const expected = policy.credential_identities[kind];
    if (
      credentials[kind].provider_object_id !== expected.provider_object_id ||
      credentials[kind].scope_id !== expected.scope_id
    ) refuse("credential_provider_identity_invalid");
  }
}

export function validateCredentialClaim(claim, policy, { nowMs = Date.now() } = {}) {
  validateCredentialLivePolicy(policy);
  exactKeys(claim, [
    "version", "transaction_id", "nonce", "candidate_sha", "ci_run_id", "ci_run_attempt",
    "created_at", "expires_at", "credentials",
  ], "claim_shape_invalid");
  if (
    claim.version !== CLAIM_VERSION || !UUID.test(claim.transaction_id) || !NONCE.test(claim.nonce) ||
    !SHA40.test(claim.candidate_sha) || typeof claim.ci_run_id !== "string" || !RUN_ID.test(claim.ci_run_id) ||
    !Number.isInteger(claim.ci_run_attempt) || claim.ci_run_attempt < 1
  ) refuse("claim_identity_invalid");
  const created = boundedTimestamp(claim.created_at, { nowMs, oldestMs: nowMs - policy.precheck_ttl_seconds * 1000 }, "claim_expired");
  const expires = timestampMs(claim.expires_at, "claim_expired");
  if (expires <= nowMs || expires <= created || expires - created > policy.precheck_ttl_seconds * 1000) refuse("claim_expired");
  validateFingerprintSet(claim.credentials, policy);
  return structuredClone(claim);
}

export function validateProviderIdentityReceipt(document, {
  policy,
  publicKeyBytes,
  claim,
  nowMs = Date.now(),
}) {
  validateCredentialLivePolicy(policy);
  exactKeys(document, [
    "version", "purpose", "policy_sha256", "claim_sha256", "candidate_sha",
    "transaction_id", "nonce", "credentials", "provider_binding", "issued_at", "expires_at", "receipt",
  ], "provider_identity_receipt_shape_invalid");
  const issued = timestampMs(document.issued_at, "provider_identity_receipt_time_invalid");
  const expires = timestampMs(document.expires_at, "provider_identity_receipt_time_invalid");
  validateCredentialClaim(claim, policy, { nowMs: issued });
  if (
    document.version !== PROVIDER_IDENTITY_RECEIPT_VERSION ||
    document.purpose !== "provider_identity" ||
    document.policy_sha256 !== policySha256(policy) ||
    document.claim_sha256 !== sha256(canonicalCredentialJsonBytes(claim)) ||
    document.candidate_sha !== claim.candidate_sha ||
    document.transaction_id !== claim.transaction_id ||
    document.nonce !== claim.nonce ||
    !sameCanonicalJson(document.credentials, claim.credentials) ||
    issued < timestampMs(claim.created_at, "provider_identity_receipt_time_invalid") ||
    issued > timestampMs(claim.expires_at, "provider_identity_receipt_time_invalid") ||
    expires <= nowMs || expires <= issued ||
    expires - issued > policy.escrow_ttl_seconds * 1000
  ) refuse("provider_identity_receipt_invalid");
  const replacement = claim.credentials.replacement_service;
  const binding = document.provider_binding;
  exactKeys(binding, [
    "operation", "endpoint_contract_sha256", "project_ref", "provider_object_id",
    "provider_kind", "scope_id", "fingerprint", "status", "observed_at",
    "provider_date", "request_id",
  ], "provider_identity_binding_shape_invalid");
  if (
    binding.operation !== "get-exact-api-key-reveal" ||
    binding.endpoint_contract_sha256 !== providerIdentityEndpointContractSha256(
      policy,
      replacement.provider_object_id,
    ) ||
    binding.project_ref !== policy.project_ref ||
    binding.provider_object_id !== replacement.provider_object_id ||
    binding.provider_kind !== policy.credential_identities.replacement_service.provider_kind ||
    binding.scope_id !== replacement.scope_id ||
    binding.fingerprint !== replacement.fingerprint ||
    binding.status !== 200
  ) refuse("provider_identity_binding_invalid");
  assertSafeId(binding.request_id, "provider_identity_binding_invalid");
  const bindingObserved = validateProviderObservation(
    binding.observed_at,
    binding.provider_date,
    { nowMs: issued, oldestMs: timestampMs(claim.created_at, "provider_identity_receipt_time_invalid") },
    "provider_identity_binding_invalid",
  );
  if (bindingObserved > issued) refuse("provider_identity_binding_invalid");
  verifyCredentialEvidenceReceipt({ document, publicKeyBytes, policy, nowMs });
  const signedAt = timestampMs(document.receipt.signed_at, "provider_identity_receipt_time_invalid");
  if (signedAt < issued || signedAt > expires) refuse("provider_identity_receipt_time_invalid");
  return {
    sha256: sha256(canonicalCredentialJsonBytes(document)),
    credentials: structuredClone(document.credentials),
  };
}

export function validatePrecheck(precheck, { policy, publicKeyBytes, claim, nowMs = Date.now() }) {
  validateCredentialLivePolicy(policy);
  exactKeys(precheck, [
    "version", "purpose", "transaction_id", "nonce", "policy_sha256", "claim_sha256",
    "candidate_sha", "ci", "transition_before_sha256", "credentials", "positive_controls",
    "protected_assets_sha256", "pre_cutover_invocation_id", "github", "supabase",
    "issued_at", "expires_at", "receipt",
  ], "precheck_shape_invalid");
  const issued = boundedTimestamp(precheck.issued_at, {
    nowMs,
    oldestMs: nowMs - policy.precheck_ttl_seconds * 1000,
  }, "precheck_expired");
  validateCredentialClaim(claim, policy, { nowMs: issued });
  if (precheck.version !== PRECHECK_VERSION || precheck.purpose !== "precheck") refuse("precheck_identity_invalid");
  if (
    precheck.transaction_id !== claim.transaction_id || precheck.nonce !== claim.nonce ||
    precheck.candidate_sha !== claim.candidate_sha
  ) refuse("precheck_identity_invalid");
  if (precheck.policy_sha256 !== policySha256(policy)) refuse("precheck_policy_invalid");
  if (precheck.claim_sha256 !== sha256(canonicalCredentialJsonBytes(claim))) refuse("precheck_claim_invalid");
  assertSha256(precheck.transition_before_sha256, "precheck_transition_invalid");
  assertSha256(precheck.protected_assets_sha256, "precheck_protected_assets_invalid");
  assertSafeId(precheck.pre_cutover_invocation_id, "precheck_service_invocation_invalid");
  validateCi(precheck.ci, policy, {
    expectedSha: claim.candidate_sha,
    expectedRun: claim.ci_run_id,
    expectedAttempt: claim.ci_run_attempt,
    nowMs: issued,
  });
  validateFingerprintSet(precheck.credentials, policy);
  if (!sameCanonicalJson(precheck.credentials, claim.credentials)) refuse("precheck_credential_identity_invalid");
  const claimCreatedMs = timestampMs(claim.created_at, "claim_expired");
  validateGithubEvidence(precheck.github, policy, {
    requiredState: "open",
    nowMs: issued,
    notBeforeMs: claimCreatedMs,
  });
  validateSupabaseEvidence(precheck.supabase, policy, {
    stage: "precheck",
    nowMs: issued,
    credentials: precheck.credentials,
    notBeforeMs: claimCreatedMs,
  });
  validatePositiveControls(precheck.positive_controls, policy, {
    credentials: precheck.credentials,
    nowMs: issued,
    notBeforeMs: claimCreatedMs,
  });
  const expires = timestampMs(precheck.expires_at, "precheck_expired");
  if (
    expires <= nowMs || expires <= issued || expires > timestampMs(claim.expires_at, "claim_expired") ||
    expires - issued > policy.precheck_ttl_seconds * 1000
  ) refuse("precheck_expired");
  const signedAt = timestampMs(precheck.receipt?.signed_at, "precheck_expired");
  if (signedAt < issued || signedAt > nowMs + 60_000) refuse("precheck_expired");
  verifyCredentialEvidenceReceipt({ document: precheck, publicKeyBytes, policy, nowMs });
  return { sha256: sha256(canonicalCredentialJsonBytes(precheck)) };
}

export function validateRevocationProof(proof, {
  policy,
  publicKeyBytes,
  claim,
  precheck,
  transitionLastBytes,
  nowMs = Date.now(),
}) {
  exactKeys(proof, [
    "version", "purpose", "transaction_id", "nonce", "policy_sha256", "candidate_sha",
    "ci", "precheck_sha256", "transition", "credentials", "github", "supabase",
    "sandwiches", "protected_assets_sha256", "pre_cutover_invocation_id",
    "post_cutover_invocation_id", "consumers", "issued_at", "expires_at", "receipt",
  ], "revocation_proof_shape_invalid");
  const issuedMs = timestampMs(proof.issued_at, "revocation_proof_timestamp_invalid");
  if (issuedMs > nowMs + 60_000) refuse("revocation_proof_timestamp_invalid");
  const transitionLast = parseTransitionLast(transitionLastBytes);
  const transitionFinishedMs = timestampMs(transitionLast.finished_at, "revocation_proof_transition_invalid");
  if (transitionFinishedMs > issuedMs) refuse("revocation_proof_transition_invalid");
  const precheckResult = validatePrecheck(precheck, {
    policy,
    publicKeyBytes,
    claim,
    nowMs: transitionFinishedMs,
  });
  if (
    proof.version !== REVOCATION_PROOF_VERSION || proof.purpose !== "revocation_proof" ||
    proof.transaction_id !== precheck.transaction_id || proof.nonce !== precheck.nonce ||
    proof.candidate_sha !== precheck.candidate_sha || proof.policy_sha256 !== policySha256(policy) ||
    proof.precheck_sha256 !== precheckResult.sha256
  ) refuse("revocation_proof_identity_invalid");
  validateCi(proof.ci, policy, {
    expectedSha: proof.candidate_sha,
    expectedRun: precheck.ci.run_id,
    expectedAttempt: precheck.ci.run_attempt,
    nowMs: issuedMs,
  });
  exactKeys(proof.transition, [
    "last_sha256", "status", "ci_run_id", "ci_run_attempt", "before_sha256", "after_sha256",
  ], "revocation_proof_transition_invalid");
  if (
    proof.transition.last_sha256 !== sha256(parseTransitionLastRecord(transitionLastBytes).evidenceBytes) ||
    proof.transition.status !== transitionLast.status ||
    proof.transition.ci_run_id !== transitionLast.ci_run_id ||
    proof.transition.ci_run_attempt !== transitionLast.ci_run_attempt ||
    proof.transition.before_sha256 !== transitionLast.before_sha256 ||
    proof.transition.after_sha256 !== transitionLast.after_sha256 ||
    transitionLast.transaction_id !== proof.transaction_id ||
    transitionLast.precheck_sha256 !== proof.precheck_sha256 ||
    transitionLast.candidate_sha !== proof.candidate_sha ||
    proof.transition.before_sha256 !== precheck.transition_before_sha256 ||
    transitionLast.ci_run_id !== proof.ci.run_id ||
    transitionLast.ci_run_attempt !== proof.ci.run_attempt
  ) refuse("revocation_proof_transition_invalid");
  assertSha256(proof.transition.before_sha256, "revocation_proof_transition_invalid");
  assertSha256(proof.transition.after_sha256, "revocation_proof_transition_invalid");
  if (!sameCanonicalJson(proof.credentials, precheck.credentials)) {
    refuse("revocation_proof_credential_identity_invalid");
  }
  assertSha256(proof.protected_assets_sha256, "revocation_proof_protected_assets_invalid");
  assertSafeId(proof.pre_cutover_invocation_id, "revocation_proof_service_invocation_invalid");
  assertSafeId(proof.post_cutover_invocation_id, "revocation_proof_service_invocation_invalid");
  if (
    proof.protected_assets_sha256 !== precheck.protected_assets_sha256 ||
    proof.pre_cutover_invocation_id !== precheck.pre_cutover_invocation_id ||
    proof.post_cutover_invocation_id === precheck.pre_cutover_invocation_id
  ) refuse("revocation_proof_control_plane_mismatch");
  validateSupabaseEvidence(proof.supabase, policy, {
    stage: "completion",
    nowMs: issuedMs,
    credentials: proof.credentials,
    notBeforeMs: transitionFinishedMs,
  });
  exactKeys(proof.sandwiches, ["pat", "service"], "revocation_proof_sandwich_invalid");
  validateSandwich(proof.sandwiches.pat, {
    kind: "pat",
    oldFingerprint: proof.credentials.old_pat.fingerprint,
    replacementFingerprint: proof.credentials.management_reader.fingerprint,
    policy,
    nowMs: issuedMs,
    notBeforeMs: transitionFinishedMs,
  });
  validateSandwich(proof.sandwiches.service, {
    kind: "service",
    oldFingerprint: proof.credentials.old_service.fingerprint,
    replacementFingerprint: proof.credentials.replacement_service.fingerprint,
    policy,
    nowMs: issuedMs,
    notBeforeMs: transitionFinishedMs,
  });
  validateConsumers(proof.consumers, policy, {
    transitionLastSha256: proof.transition.last_sha256,
    invocationId: proof.post_cutover_invocation_id,
    replacementFingerprint: proof.credentials.replacement_service.fingerprint,
    protectedAssetsSha256: proof.protected_assets_sha256,
    nowMs: issuedMs,
    notBeforeMs: transitionFinishedMs,
  });
  const providerVerifiedMs = Math.max(
    timestampMs(proof.supabase.observed_at, "revocation_proof_provider_order_invalid"),
    timestampMs(proof.sandwiches.pat.finished_at, "revocation_proof_provider_order_invalid"),
    timestampMs(proof.sandwiches.service.finished_at, "revocation_proof_provider_order_invalid"),
    ...proof.consumers.map((consumer) => timestampMs(
      consumer.observed_at,
      "revocation_proof_provider_order_invalid",
    )),
  );
  validateGithubEvidence(proof.github, policy, {
    requiredState: "open",
    nowMs: issuedMs,
    notBeforeMs: providerVerifiedMs,
  });
  const githubOpenObservedMs = timestampMs(proof.github.observed_at, "revocation_proof_provider_order_invalid");
  if (githubOpenObservedMs < providerVerifiedMs || issuedMs < githubOpenObservedMs) {
    refuse("revocation_proof_provider_order_invalid");
  }
  const expiresMs = timestampMs(proof.expires_at, "revocation_proof_timestamp_invalid");
  if (
    expiresMs <= nowMs || expiresMs <= issuedMs ||
    expiresMs - issuedMs > policy.escrow_ttl_seconds * 1000
  ) refuse("revocation_proof_timestamp_invalid");
  const signedAtMs = timestampMs(proof.receipt?.signed_at, "revocation_proof_timestamp_invalid");
  if (signedAtMs < issuedMs || signedAtMs > issuedMs + 60_000) {
    refuse("revocation_proof_timestamp_invalid");
  }
  verifyCredentialEvidenceReceipt({ document: proof, publicKeyBytes, policy, nowMs });
  return {
    sha256: sha256(canonicalCredentialJsonBytes(proof)),
    issuedMs,
    githubOpenProviderMs: Date.parse(proof.github.provider_date),
    transitionLastSha256: proof.transition.last_sha256,
  };
}

export function validateCompletion(completion, {
  policy,
  publicKeyBytes,
  claim,
  precheck,
  transitionLastBytes,
  nowMs = Date.now(),
}) {
  exactKeys(completion, [
    "version", "purpose", "transaction_id", "nonce", "policy_sha256", "candidate_sha",
    "ci", "precheck_sha256", "transition", "credentials", "github", "supabase",
    "sandwiches", "protected_assets_sha256", "pre_cutover_invocation_id",
    "post_cutover_invocation_id", "consumers", "revocation_proof",
    "issued_at", "expires_at", "receipt",
  ], "completion_shape_invalid");
  const completionIssuedMs = timestampMs(completion.issued_at, "completion_timestamp_invalid");
  if (completionIssuedMs > nowMs + 60_000) refuse("completion_timestamp_invalid");
  const transitionLast = parseTransitionLast(transitionLastBytes);
  const transitionFinishedMs = timestampMs(transitionLast.finished_at, "completion_transition_invalid");
  if (transitionFinishedMs > completionIssuedMs) refuse("completion_transition_invalid");
  const precheckResult = validatePrecheck(precheck, {
    policy,
    publicKeyBytes,
    claim,
    nowMs: transitionFinishedMs,
  });
  if (
    completion.version !== COMPLETION_VERSION || completion.purpose !== "completion" ||
    completion.transaction_id !== precheck.transaction_id || completion.nonce !== precheck.nonce ||
    completion.candidate_sha !== precheck.candidate_sha || completion.policy_sha256 !== policySha256(policy) ||
    completion.precheck_sha256 !== precheckResult.sha256
  ) refuse("completion_identity_invalid");
  validateCi(completion.ci, policy, {
    expectedSha: completion.candidate_sha,
    expectedRun: precheck.ci.run_id,
    expectedAttempt: precheck.ci.run_attempt,
    nowMs: completionIssuedMs,
  });
  exactKeys(completion.transition, ["last_sha256", "status", "ci_run_id", "ci_run_attempt", "before_sha256", "after_sha256"], "completion_transition_invalid");
  if (
    completion.transition.last_sha256 !== sha256(parseTransitionLastRecord(transitionLastBytes).evidenceBytes) ||
    completion.transition.status !== transitionLast.status ||
    completion.transition.ci_run_id !== transitionLast.ci_run_id ||
    completion.transition.ci_run_attempt !== transitionLast.ci_run_attempt ||
    completion.transition.before_sha256 !== transitionLast.before_sha256 ||
    completion.transition.after_sha256 !== transitionLast.after_sha256 ||
    transitionLast.transaction_id !== completion.transaction_id ||
    transitionLast.precheck_sha256 !== completion.precheck_sha256 ||
    transitionLast.candidate_sha !== completion.candidate_sha ||
    completion.transition.before_sha256 !== precheck.transition_before_sha256 ||
    transitionLast.ci_run_id !== completion.ci.run_id ||
    transitionLast.ci_run_attempt !== completion.ci.run_attempt
  ) refuse("completion_transition_invalid");
  assertSha256(completion.transition.before_sha256, "completion_transition_invalid");
  assertSha256(completion.transition.after_sha256, "completion_transition_invalid");
  if (!sameCanonicalJson(completion.credentials, precheck.credentials)) refuse("completion_credential_identity_invalid");
  assertSha256(completion.protected_assets_sha256, "completion_protected_assets_invalid");
  assertSafeId(completion.pre_cutover_invocation_id, "completion_service_invocation_invalid");
  assertSafeId(completion.post_cutover_invocation_id, "completion_service_invocation_invalid");
  if (
    completion.protected_assets_sha256 !== precheck.protected_assets_sha256 ||
    completion.pre_cutover_invocation_id !== precheck.pre_cutover_invocation_id ||
    completion.post_cutover_invocation_id === precheck.pre_cutover_invocation_id
  ) refuse("completion_control_plane_mismatch");
  const proofResult = validateRevocationProof(completion.revocation_proof, {
    policy,
    publicKeyBytes,
    claim,
    precheck,
    transitionLastBytes,
    nowMs: completionIssuedMs,
  });
  if (
    completion.revocation_proof.transaction_id !== completion.transaction_id ||
    completion.revocation_proof.nonce !== completion.nonce ||
    completion.revocation_proof.candidate_sha !== completion.candidate_sha ||
    completion.revocation_proof.precheck_sha256 !== completion.precheck_sha256 ||
    completion.revocation_proof.transition.last_sha256 !== completion.transition.last_sha256 ||
    completion.revocation_proof.transition.before_sha256 !== completion.transition.before_sha256 ||
    completion.revocation_proof.transition.after_sha256 !== completion.transition.after_sha256 ||
    !sameCanonicalJson(completion.revocation_proof.credentials, completion.credentials) ||
    completion.revocation_proof.protected_assets_sha256 !== completion.protected_assets_sha256 ||
    completion.revocation_proof.pre_cutover_invocation_id !== completion.pre_cutover_invocation_id
  ) refuse("completion_revocation_proof_mismatch");
  validateGithubEvidence(completion.github, policy, {
    requiredState: "resolved",
    nowMs: completionIssuedMs,
    notBeforeMs: proofResult.issuedMs,
    resolvedNotBeforeMs: proofResult.githubOpenProviderMs,
  });
  validateSupabaseEvidence(completion.supabase, policy, {
    stage: "completion",
    nowMs: completionIssuedMs,
    credentials: completion.credentials,
    notBeforeMs: proofResult.issuedMs,
  });
  exactKeys(completion.sandwiches, ["pat", "service"], "completion_sandwich_invalid");
  validateSandwich(completion.sandwiches.pat, {
    kind: "pat",
    oldFingerprint: completion.credentials.old_pat.fingerprint,
    replacementFingerprint: completion.credentials.management_reader.fingerprint,
    policy,
    nowMs: completionIssuedMs,
    notBeforeMs: proofResult.issuedMs,
  });
  validateSandwich(completion.sandwiches.service, {
    kind: "service",
    oldFingerprint: completion.credentials.old_service.fingerprint,
    replacementFingerprint: completion.credentials.replacement_service.fingerprint,
    policy,
    nowMs: completionIssuedMs,
    notBeforeMs: proofResult.issuedMs,
  });
  validateConsumers(completion.consumers, policy, {
    transitionLastSha256: completion.transition.last_sha256,
    invocationId: completion.post_cutover_invocation_id,
    replacementFingerprint: completion.credentials.replacement_service.fingerprint,
    protectedAssetsSha256: completion.protected_assets_sha256,
    nowMs: completionIssuedMs,
    notBeforeMs: proofResult.issuedMs,
  });
  const completionProviderVerifiedAt = Math.max(
    timestampMs(completion.supabase.observed_at, "completion_provider_order_invalid"),
    timestampMs(completion.sandwiches.pat.finished_at, "completion_provider_order_invalid"),
    timestampMs(completion.sandwiches.service.finished_at, "completion_provider_order_invalid"),
    ...completion.consumers.map((consumer) => timestampMs(
      consumer.observed_at,
      "completion_provider_order_invalid",
    )),
  );
  if (
    timestampMs(completion.github.observed_at, "completion_provider_order_invalid") < completionProviderVerifiedAt
  ) refuse("completion_provider_order_invalid");
  if (completionIssuedMs < timestampMs(completion.github.observed_at, "completion_timestamp_invalid")) {
    refuse("completion_timestamp_invalid");
  }
  const issued = boundedTimestamp(completion.issued_at, {
    nowMs: completionIssuedMs,
    oldestMs: transitionFinishedMs,
  }, "completion_timestamp_invalid");
  const expires = timestampMs(completion.expires_at, "completion_timestamp_invalid");
  if (expires <= nowMs || expires <= issued || expires - issued > policy.completion_max_age_seconds * 1000) refuse("completion_timestamp_invalid");
  const signedAt = timestampMs(completion.receipt?.signed_at, "completion_timestamp_invalid");
  if (signedAt < issued || signedAt - issued > policy.precheck_ttl_seconds * 1000) {
    refuse("completion_timestamp_invalid");
  }
  verifyCredentialEvidenceReceipt({ document: completion, publicKeyBytes, policy, nowMs });
  return { sha256: sha256(canonicalCredentialJsonBytes(completion)), transitionLastSha256: completion.transition.last_sha256 };
}

export function validateReleaseRelation(relation, { remediationSha, releaseSha, measureRelation }) {
  exactKeys(relation, ["remediation_sha", "release_sha", "commit_count", "direct_parent", "changed_paths", "per_commit_changed_paths"], "release_relation_shape_invalid");
  if (
    relation.remediation_sha !== remediationSha || relation.release_sha !== releaseSha ||
    relation.commit_count !== 1 || relation.direct_parent !== remediationSha ||
    !sameCanonicalJson(relation.changed_paths, ["TASKBOARD.md"]) ||
    !sameCanonicalJson(relation.per_commit_changed_paths, [["TASKBOARD.md"]])
  ) refuse("release_relation_invalid");
  if (typeof measureRelation !== "function") refuse("release_relation_unmeasured");
  let measured;
  try {
    measured = measureRelation({ remediationSha, releaseSha });
  } catch {
    refuse("release_relation_measurement_failed");
  }
  if (!sameCanonicalJson(measured, relation)) refuse("release_relation_measurement_mismatch");
}

export function validateReadback(readback, {
  policy,
  publicKeyBytes,
  completion,
  transitionLastBytes,
  expectedRun,
  expectedAttempt,
  measureReleaseRelation,
  nowMs = Date.now(),
}) {
  exactKeys(readback, [
    "version", "purpose", "transaction_id", "nonce", "policy_sha256", "completion_sha256",
    "remediation_sha", "release_sha", "ci", "claim", "precheck", "github", "supabase",
    "sandwiches", "protected_assets_sha256", "post_cutover_invocation_id", "service_probe",
    "consumers", "relation", "observed_at", "expires_at", "receipt",
  ], "readback_shape_invalid");
  const observed = boundedTimestamp(readback.observed_at, {
    nowMs,
    oldestMs: nowMs - policy.live_readback_ttl_seconds * 1000,
  }, "readback_expired");
  const completionResult = validateCompletion(completion, {
    policy,
    publicKeyBytes,
    precheck: readback.precheck,
    claim: readback.claim,
    transitionLastBytes,
    nowMs,
  });
  if (
    readback.version !== READBACK_VERSION || readback.purpose !== "readback" ||
    readback.transaction_id !== completion.transaction_id || readback.nonce !== completion.nonce ||
    readback.policy_sha256 !== policySha256(policy) || readback.completion_sha256 !== completionResult.sha256 ||
    readback.remediation_sha !== completion.candidate_sha || !SHA40.test(readback.release_sha)
  ) refuse("readback_identity_invalid");
  if (readback.protected_assets_sha256 !== completion.protected_assets_sha256) {
    refuse("readback_control_plane_identity_invalid");
  }
  validateCi(readback.ci, policy, {
    expectedSha: readback.release_sha,
    expectedRun,
    expectedAttempt,
    nowMs: observed,
  });
  validateReleaseRelation(readback.relation, {
    remediationSha: readback.remediation_sha,
    releaseSha: readback.release_sha,
    measureRelation: measureReleaseRelation,
  });
  const completionIssuedMs = timestampMs(completion.issued_at, "completion_timestamp_invalid");
  const transitionFinishedMs = timestampMs(
    parseTransitionLast(transitionLastBytes).finished_at,
    "readback_provider_time_invalid",
  );
  if (!sameCanonicalJson(readback.github.alerts, completion.github.alerts)) {
    refuse("readback_github_alert_identity_changed");
  }
  validateGithubEvidence(readback.github, policy, {
    requiredState: "resolved",
    nowMs: observed,
    notBeforeMs: completionIssuedMs,
    resolvedNotBeforeMs: transitionFinishedMs,
  });
  validateSupabaseEvidence(readback.supabase, policy, {
    stage: "completion",
    nowMs: observed,
    credentials: completion.credentials,
    notBeforeMs: completionIssuedMs,
  });
  if (
    timestampMs(readback.github.observed_at, "readback_provider_time_invalid") < completionIssuedMs ||
    timestampMs(readback.supabase.observed_at, "readback_provider_time_invalid") < completionIssuedMs
  ) refuse("readback_provider_time_invalid");
  exactKeys(readback.sandwiches, ["pat", "service"], "readback_sandwich_invalid");
  validateSandwich(readback.sandwiches.pat, {
    kind: "pat",
    oldFingerprint: completion.credentials.old_pat.fingerprint,
    replacementFingerprint: completion.credentials.management_reader.fingerprint,
    policy,
    nowMs: observed,
    notBeforeMs: completionIssuedMs,
  });
  validateSandwich(readback.sandwiches.service, {
    kind: "service",
    oldFingerprint: completion.credentials.old_service.fingerprint,
    replacementFingerprint: completion.credentials.replacement_service.fingerprint,
    policy,
    nowMs: observed,
    notBeforeMs: completionIssuedMs,
  });
  exactKeys(readback.service_probe, ["status", "provider_code", "request_id", "fingerprint", "observed_at", "provider_date"], "readback_service_probe_invalid");
  if (
    readback.service_probe.status !== 200 || readback.service_probe.provider_code !== "success" ||
    readback.service_probe.fingerprint !== completion.credentials.replacement_service.fingerprint ||
    !SAFE_ID.test(readback.service_probe.request_id)
  ) refuse("readback_service_probe_invalid");
  validateProviderObservation(readback.service_probe.observed_at, readback.service_probe.provider_date, {
    nowMs: observed,
    oldestMs: completionIssuedMs,
  }, "readback_service_probe_invalid");
  validateConsumers(readback.consumers, policy, {
    transitionLastSha256: completion.transition.last_sha256,
    invocationId: readback.post_cutover_invocation_id,
    replacementFingerprint: completion.credentials.replacement_service.fingerprint,
    protectedAssetsSha256: readback.protected_assets_sha256,
    nowMs: observed,
    notBeforeMs: completionIssuedMs,
  });
  const expires = timestampMs(readback.expires_at, "readback_expired");
  if (expires <= nowMs || expires <= observed || expires - observed > policy.live_readback_ttl_seconds * 1000) refuse("readback_expired");
  const signedAt = timestampMs(readback.receipt?.signed_at, "readback_expired");
  if (signedAt < observed || signedAt > nowMs + 60_000) refuse("readback_expired");
  verifyCredentialEvidenceReceipt({ document: readback, publicKeyBytes, policy, nowMs });
  return { sha256: sha256(canonicalCredentialJsonBytes(readback)), completionSha256: completionResult.sha256 };
}

export function validateTombstone(tombstone, {
  policy,
  publicKeyBytes,
  completion,
  precheck,
  claim,
  transitionLastBytes,
  readback,
  expectedReleaseSha,
  expectedRun,
  expectedAttempt,
  measureReleaseRelation,
  nowMs = Date.now(),
}) {
  exactKeys(tombstone, [
    "version", "purpose", "state", "transaction_id", "nonce", "candidate_sha", "release_sha",
    "ci_run_id", "ci_run_attempt", "transition_last_sha256", "completion_sha256", "readback_sha256",
    "consumed_at", "receipt",
  ], "tombstone_shape_invalid");
  const consumed = timestampMs(tombstone.consumed_at, "tombstone_timestamp_invalid");
  if (consumed > nowMs + 60_000) refuse("tombstone_timestamp_invalid");
  const completionResult = validateCompletion(completion, {
    policy,
    publicKeyBytes,
    precheck,
    claim,
    transitionLastBytes,
    nowMs: consumed,
  });
  const readbackResult = validateReadback(readback, {
    policy,
    publicKeyBytes,
    completion,
    transitionLastBytes,
    expectedRun,
    expectedAttempt,
    measureReleaseRelation,
    nowMs: consumed,
  });
  if (
    tombstone.version !== TOMBSTONE_VERSION || tombstone.purpose !== "tombstone" || tombstone.state !== "consumed" ||
    tombstone.transaction_id !== completion.transaction_id || tombstone.nonce !== completion.nonce ||
    tombstone.candidate_sha !== completion.candidate_sha || tombstone.release_sha !== expectedReleaseSha ||
    !SHA40.test(tombstone.release_sha) || tombstone.release_sha !== readback.release_sha ||
    tombstone.ci_run_id !== readback.ci.run_id || tombstone.ci_run_attempt !== readback.ci.run_attempt ||
    tombstone.transition_last_sha256 !== completionResult.transitionLastSha256 ||
    tombstone.completion_sha256 !== completionResult.sha256 ||
    tombstone.readback_sha256 !== readbackResult.sha256
  ) refuse("tombstone_identity_invalid");
  if (
    consumed < timestampMs(readback.observed_at, "tombstone_timestamp_invalid") ||
    consumed < timestampMs(readback.receipt?.signed_at, "tombstone_timestamp_invalid")
  ) {
    refuse("tombstone_timestamp_invalid");
  }
  const signedAt = timestampMs(tombstone.receipt?.signed_at, "tombstone_timestamp_invalid");
  if (signedAt < consumed || signedAt > consumed + 60_000) refuse("tombstone_timestamp_invalid");
  verifyCredentialEvidenceReceipt({ document: tombstone, publicKeyBytes, policy, nowMs: consumed });
  return { sha256: sha256(canonicalCredentialJsonBytes(tombstone)) };
}

const LIVE_STATE_VERSION = "newme-credential-live-state/v1";
const ESCROW_VERSION = "newme-credential-live-escrow/v1";
const ESCROW_FILE = "sealed.json";

function isoAt(value) {
  return new Date(value).toISOString();
}

function providerRequestId(headers) {
  for (const name of ["x-github-request-id", "x-request-id", "sb-request-id", "cf-ray"]) {
    const value = headers.get(name);
    if (value && SAFE_ID.test(value)) return value;
  }
  refuse("provider_request_id_missing");
}

async function fetchProviderJson({ fetchImpl, url, headers, policy, nowMs, label, method = "GET", body }) {
  const expectedOrigin = new URL(url).origin;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: canonicalCredentialJsonBytes(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(policy.request_timeout_ms),
    });
  } catch {
    refuse(`${label}_request_failed`);
  }
  if (response.url && new URL(response.url).origin !== expectedOrigin) refuse(`${label}_origin_changed`);
  if (response.status >= 300 && response.status < 400) refuse(`${label}_redirect_refused`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > policy.max_response_bytes) refuse(`${label}_response_too_large`);
  let bytes;
  try {
    if (response.body && typeof response.body.getReader === "function") {
      const chunks = [];
      let total = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > policy.max_response_bytes) {
          await reader.cancel();
          refuse(`${label}_response_too_large`);
        }
        chunks.push(Buffer.from(value));
      }
      bytes = Buffer.concat(chunks, total);
    } else {
      refuse(`${label}_response_stream_required`);
    }
  } catch (error) {
    if (error instanceof CredentialLiveError) throw error;
    refuse(`${label}_body_read_failed`);
  }
  if (bytes.length > policy.max_response_bytes) refuse(`${label}_response_too_large`);
  let responseBody = null;
  if (bytes.length > 0) {
    try { responseBody = JSON.parse(bytes.toString("utf8")); } catch { refuse(`${label}_response_invalid`); }
  }
  const providerDate = response.headers.get("date");
  const localObservedMs = nowMs();
  const providerObservedMs = typeof providerDate === "string" ? Date.parse(providerDate) : Number.NaN;
  if (
    typeof providerDate !== "string" || !Number.isFinite(providerObservedMs) ||
    new Date(providerObservedMs).toUTCString() !== providerDate ||
    providerObservedMs > localObservedMs + 60_000 ||
    Math.abs(providerObservedMs - localObservedMs) > 120_000
  ) {
    refuse(`${label}_provider_date_invalid`);
  }
  const observedAt = isoAt(localObservedMs);
  return {
    status: response.status,
    body: responseBody,
    observedAt,
    providerDate,
    requestId: providerRequestId(response.headers),
    link: response.headers.get("link") ?? "",
  };
}

function githubHeaders(policy, token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token.toString("utf8")}`,
    "User-Agent": policy.user_agent,
    "X-GitHub-Api-Version": policy.github_api_version,
  };
}

function serviceHeaders(policy, token, providerKind) {
  const value = token.toString("utf8");
  const headers = {
    Accept: "application/json",
    apikey: value,
    "User-Agent": policy.user_agent,
  };
  if (providerKind === "legacy_service_role") headers.Authorization = `Bearer ${value}`;
  else if (providerKind !== "secret") refuse("service_provider_kind_invalid");
  return headers;
}

function patHeaders(policy, token) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token.toString("utf8")}`,
    "User-Agent": policy.user_agent,
  };
}

function providerCode(result, kind) {
  if (result.status === 200) return "success";
  if (result.status !== 401) refuse(`${kind}_probe_not_invalid`);
  return kind === "service" ? "unregistered_api_key" : "unauthorized";
}

function requireCredentialFingerprint({
  policy,
  fingerprintKey,
  transactionId,
  nonce,
  credentialKind,
  token,
  expectedFingerprint,
}) {
  if (!Buffer.isBuffer(token)) refuse("credential_probe_secret_invalid");
  const actual = credentialFingerprint({
    keyBytes: fingerprintKey,
    keyId: policy.fingerprints.key_id,
    transactionId,
    nonce,
    kind: credentialKind,
    secretBytes: token,
  });
  if (actual !== expectedFingerprint) refuse("credential_probe_fingerprint_mismatch");
}

async function probeCredential({
  fetchImpl,
  policy,
  kind,
  credentialKind,
  token,
  fingerprint,
  fingerprintKey,
  transactionId,
  nonce,
  providerKind,
  nowMs,
}) {
  requireCredentialFingerprint({
    policy,
    fingerprintKey,
    transactionId,
    nonce,
    credentialKind,
    token,
    expectedFingerprint: fingerprint,
  });
  const pathValue = kind === "service" ? policy.service_probe_path : policy.management_probe_path;
  const origin = kind === "service" ? policy.supabase_data_origin : policy.supabase_management_origin;
  const headers = kind === "service" ? serviceHeaders(policy, token, providerKind) : patHeaders(policy, token);
  const result = await fetchProviderJson({
    fetchImpl,
    url: `${origin}${pathValue}`,
    headers,
    policy,
    nowMs,
    label: `${kind}_probe`,
  });
  return {
    status: result.status,
    provider_code: providerCode(result, kind),
    request_id: result.requestId,
    fingerprint,
    observed_at: result.observedAt,
    provider_date: result.providerDate,
  };
}

function githubRequestProjection(operation, result) {
  return {
    operation,
    status: result.status,
    observed_at: result.observedAt,
    provider_date: result.providerDate,
    request_id: result.requestId,
    link_sha256: sha256(result.link),
  };
}

export function githubNextLink(value, { origin, basePath, currentPage, visitedUrls }) {
  if (!value) return null;
  const next = value.split(",").map((part) => part.trim()).find((part) => /;\s*rel="next"$/.test(part));
  if (!next) return null;
  const match = /^<([^>]+)>;\s*rel="next"$/.exec(next);
  if (!match) refuse("github_alert_pagination_invalid");
  const parsed = new URL(match[1]);
  const queryKeys = [...parsed.searchParams.keys()].sort();
  const expectedKeys = ["hide_secret", "page", "per_page", "state"];
  const nextPage = String(currentPage + 1);
  if (
    parsed.origin !== origin || parsed.pathname !== basePath || parsed.username !== "" ||
    parsed.password !== "" || parsed.hash !== "" ||
    JSON.stringify(queryKeys) !== JSON.stringify(expectedKeys) ||
    expectedKeys.some((key) => parsed.searchParams.getAll(key).length !== 1) ||
    parsed.searchParams.get("state") !== "open" ||
    parsed.searchParams.get("hide_secret") !== "true" ||
    parsed.searchParams.get("per_page") !== "100" ||
    parsed.searchParams.get("page") !== nextPage ||
    visitedUrls.has(parsed.toString())
  ) {
    refuse("github_alert_pagination_invalid");
  }
  return parsed.toString();
}

async function collectGithubEvidence({ fetchImpl, policy, token, requiredState, nowMs }) {
  const base = `${policy.github_api_origin}/repos/${policy.repository}/secret-scanning/alerts`;
  const headers = githubHeaders(policy, token);
  const alerts = [];
  const requests = [];
  for (const expected of policy.expected_alerts) {
    const result = await fetchProviderJson({
      fetchImpl,
      url: `${base}/${expected.number}?hide_secret=true`,
      headers,
      policy,
      nowMs,
      label: "github_alert",
    });
    if (result.status !== 200 || !object(result.body)) refuse("github_alert_request_refused");
    requests.push(githubRequestProjection(`alert-${expected.number}`, result));
    alerts.push({
      number: result.body.number,
      secret_type: result.body.secret_type,
      state: result.body.state,
      resolution: result.body.resolution ?? null,
      resolved_at: result.body.resolved_at ?? null,
      publicly_leaked: result.body.publicly_leaked,
    });
  }
  let openCount = 0;
  let pagesRead = 0;
  let finalResponse = null;
  let nextUrl = `${base}?state=open&hide_secret=true&per_page=100&page=1`;
  const visitedUrls = new Set();
  for (let page = 1; page <= policy.max_pages; page += 1) {
    if (visitedUrls.has(nextUrl)) refuse("github_alert_pagination_invalid");
    visitedUrls.add(nextUrl);
    const result = await fetchProviderJson({
      fetchImpl,
      url: nextUrl,
      headers,
      policy,
      nowMs,
      label: "github_alert_list",
    });
    if (result.status !== 200 || !Array.isArray(result.body)) refuse("github_alert_list_refused");
    pagesRead += 1;
    openCount += result.body.length;
    finalResponse = result;
    requests.push(githubRequestProjection(`open-page-${page}`, result));
    nextUrl = githubNextLink(result.link, {
      origin: policy.github_api_origin,
      basePath: `/repos/${policy.repository}/secret-scanning/alerts`,
      currentPage: page,
      visitedUrls,
    });
    if (nextUrl === null) break;
    if (page === policy.max_pages) refuse("github_alert_pagination_incomplete");
  }
  const evidence = {
    repository: policy.repository,
    api_version: policy.github_api_version,
    hide_secret: true,
    pages_read: pagesRead,
    pagination_complete: true,
    open_count: openCount,
    alerts,
    requests,
    observed_at: finalResponse.observedAt,
    provider_date: finalResponse.providerDate,
    request_id: finalResponse.requestId,
  };
  validateGithubEvidence(evidence, policy, {
    requiredState,
    nowMs: Date.parse(evidence.observed_at),
    notBeforeMs: Date.parse(evidence.observed_at) - policy.live_readback_ttl_seconds * 1000,
  });
  return evidence;
}

export async function collectSupabaseEvidence({
  fetchImpl,
  policy,
  token,
  credentials,
  stage,
  nowMs,
  providerIdentityReceipt,
  publicKeyBytes,
  claim,
}) {
  const byId = new Map();
  const result = await fetchProviderJson({
    fetchImpl,
    url: `${policy.supabase_management_origin}${policy.provider_keys_path}?reveal=false`,
    headers: patHeaders(policy, token),
    policy,
    nowMs,
    label: "supabase_key_inventory",
  });
  if (result.status !== 200 || !Array.isArray(result.body)) refuse("supabase_key_inventory_refused");
  for (const item of result.body) {
    if (!object(item) || typeof item.id !== "string" || byId.has(item.id)) refuse("supabase_key_inventory_invalid");
    if (typeof item.type !== "string" || !["secret", "legacy", "publishable"].includes(item.type)) {
      refuse("supabase_key_inventory_invalid");
    }
    const normalizedType = item.type === "legacy" && item.id === "service_role"
      ? "legacy_service_role"
      : item.type;
    byId.set(item.id, { id: item.id, type: normalizedType });
  }
  const identityBinding = validateProviderIdentityReceipt(providerIdentityReceipt, {
    policy,
    publicKeyBytes,
    claim,
    nowMs: Date.parse(result.observedAt),
  });
  const projection = (kind, present) => {
    const identity = credentials[kind];
    const item = byId.get(identity.provider_object_id);
    const providerKind = item?.type ?? policy.credential_identities[kind].provider_kind;
    const receiptIdentity = identityBinding.credentials[kind];
    const receiptMatches = sameCanonicalJson(receiptIdentity, identity);
    return {
      provider_object_id: identity.provider_object_id,
      kind: providerKind,
      scope_id: identity.scope_id,
      present,
      policy_identity_match: receiptMatches && present && (kind !== "old_service" || stage === "precheck"),
    };
  };
  const oldPresent = byId.has(credentials.old_service.provider_object_id);
  const replacementPresent = byId.has(credentials.replacement_service.provider_object_id);
  const evidence = {
    project_ref: policy.project_ref,
    reveal: false,
    pagination_complete: true,
    pages_read: 1,
    old_service: projection("old_service", oldPresent),
    replacement_service: projection("replacement_service", replacementPresent),
    observed_at: result.observedAt,
    provider_date: result.providerDate,
    request_id: result.requestId,
  };
  validateSupabaseEvidence(evidence, policy, {
    stage,
    nowMs: Date.parse(evidence.observed_at),
    credentials,
    notBeforeMs: Date.parse(evidence.observed_at) - policy.live_readback_ttl_seconds * 1000,
  });
  return evidence;
}

async function collectCiEvidence({ fetchImpl, policy, token, candidateSha, runId, runAttempt, nowMs }) {
  const headers = githubHeaders(policy, token);
  const runResult = await fetchProviderJson({
    fetchImpl,
    url: `${policy.github_api_origin}/repos/${policy.repository}/actions/runs/${runId}`,
    headers,
    policy,
    nowMs,
    label: "github_ci_run",
  });
  const workflowResult = await fetchProviderJson({
    fetchImpl,
    url: `${policy.github_api_origin}/repos/${policy.repository}/actions/workflows/${policy.workflow.id}`,
    headers,
    policy,
    nowMs,
    label: "github_ci_workflow",
  });
  if (runResult.status !== 200 || workflowResult.status !== 200 || !object(runResult.body) || !object(workflowResult.body)) {
    refuse("ci_provider_readback_refused");
  }
  if (
    workflowResult.body.id !== policy.workflow.id || workflowResult.body.path !== policy.workflow.path ||
    workflowResult.body.state !== "active"
  ) refuse("ci_workflow_identity_invalid");
  const ci = {
    workflow_id: runResult.body.workflow_id,
    workflow_path: workflowResult.body.path,
    event: runResult.body.event,
    head_branch: runResult.body.head_branch,
    run_id: String(runResult.body.id),
    run_attempt: runResult.body.run_attempt,
    head_sha: runResult.body.head_sha,
    status: runResult.body.status,
    conclusion: runResult.body.conclusion,
    completed_at: runResult.body.updated_at,
    verified_at: workflowResult.observedAt,
    requests: [
      {
        operation: "run",
        status: runResult.status,
        observed_at: runResult.observedAt,
        provider_date: runResult.providerDate,
        request_id: runResult.requestId,
      },
      {
        operation: "workflow",
        status: workflowResult.status,
        observed_at: workflowResult.observedAt,
        provider_date: workflowResult.providerDate,
        request_id: workflowResult.requestId,
      },
    ],
  };
  validateCi(ci, policy, {
    expectedSha: candidateSha,
    expectedRun: runId,
    expectedAttempt: runAttempt,
    nowMs: Date.parse(ci.verified_at),
  });
  return ci;
}

function createCredentialIdentities({ policy, fingerprintKey, transactionId, nonce, secretBytesByKind }) {
  const credentials = {};
  for (const kind of ["old_pat", "management_reader", "old_service", "replacement_service"]) {
    const policyIdentity = policy.credential_identities[kind];
    credentials[kind] = {
      kind,
      fingerprint: credentialFingerprint({
        keyBytes: fingerprintKey,
        keyId: policy.fingerprints.key_id,
        transactionId,
        nonce,
        kind,
        secretBytes: secretBytesByKind[kind],
      }),
      provider_object_id: policyIdentity.provider_object_id,
      scope_id: policyIdentity.scope_id,
    };
  }
  validateFingerprintSet(credentials, policy);
  return credentials;
}

async function collectPositiveControls({
  fetchImpl,
  policy,
  credentials,
  secretBytesByKind,
  fingerprintKey,
  transactionId,
  nonce,
  nowMs,
}) {
  const controls = [];
  for (const [credential, kind] of [
    ["old_pat", "pat"],
    ["management_reader", "pat"],
    ["old_service", "service"],
    ["replacement_service", "service"],
  ]) {
    const probe = await probeCredential({
      fetchImpl,
      policy,
      kind,
      credentialKind: credential,
      token: secretBytesByKind[credential],
      fingerprint: credentials[credential].fingerprint,
      fingerprintKey,
      transactionId,
      nonce,
      providerKind: policy.credential_identities[credential].provider_kind,
      nowMs,
    });
    if (probe.status !== 200 || probe.provider_code !== "success") refuse("positive_control_refused");
    controls.push({
      credential,
      endpoint_contract_sha256: endpointContractSha256(policy, kind),
      ...probe,
    });
  }
  return controls;
}

async function collectSandwich({
  fetchImpl,
  policy,
  kind,
  oldCredential,
  replacementCredential,
  oldFingerprint,
  replacementFingerprint,
  fingerprintKey,
  transactionId,
  nonce,
  oldCredentialKind,
  replacementCredentialKind,
  oldProviderKind,
  replacementProviderKind,
  nowMs,
}) {
  const startedAt = isoAt(nowMs());
  const steps = [];
  for (const [credential, credentialKind, token, fingerprint, providerKind] of [
    ["replacement_before", replacementCredentialKind, replacementCredential, replacementFingerprint, replacementProviderKind],
    ["old", oldCredentialKind, oldCredential, oldFingerprint, oldProviderKind],
    ["replacement_after", replacementCredentialKind, replacementCredential, replacementFingerprint, replacementProviderKind],
  ]) {
    const probe = await probeCredential({
      fetchImpl,
      policy,
      kind,
      credentialKind,
      token,
      fingerprint,
      fingerprintKey,
      transactionId,
      nonce,
      providerKind,
      nowMs,
    });
    steps.push({
      credential,
      status: probe.status,
      provider_code: probe.provider_code,
      request_id: probe.request_id,
      observed_at: probe.observed_at,
      provider_date: probe.provider_date,
    });
  }
  const evidence = {
    kind,
    endpoint_contract_sha256: endpointContractSha256(policy, kind),
    old_fingerprint: oldFingerprint,
    replacement_fingerprint: replacementFingerprint,
    steps,
    started_at: startedAt,
    finished_at: isoAt(nowMs()),
  };
  validateSandwich(evidence, {
    kind,
    oldFingerprint,
    replacementFingerprint,
    policy,
    nowMs: Date.parse(evidence.finished_at),
    notBeforeMs: Date.parse(evidence.started_at),
  });
  return evidence;
}

function createConsumerEvidence({
  policy,
  transitionLastSha256,
  invocationId,
  replacementFingerprint,
  protectedAssetsSha256,
  runCommand,
  serviceProbe,
  measureControlPlane,
  nowMs,
}) {
  return policy.required_consumers.map((consumer) => {
    const before = measureControlPlane();
    if (
      before.protectedAssetsSha256 !== protectedAssetsSha256 ||
      before.invocationId !== invocationId
    ) refuse("consumer_control_plane_changed");
    let observedAt = isoAt(nowMs());
    if (consumer.kind === "supabase_service_role_read") {
      if (
        !object(serviceProbe) || serviceProbe.status !== 200 || serviceProbe.provider_code !== "success" ||
        serviceProbe.fingerprint !== replacementFingerprint
      ) refuse("consumer_service_probe_failed");
      observedAt = serviceProbe.observed_at;
    } else if (consumer.kind === "root_command") {
      const result = runCommand(consumer.path);
      if (result !== 0) refuse("consumer_command_failed");
    }
    const after = measureControlPlane();
    if (
      after.protectedAssetsSha256 !== protectedAssetsSha256 ||
      after.invocationId !== invocationId
    ) refuse("consumer_control_plane_changed");
    const evidence = {
      id: consumer.id,
      kind: consumer.kind,
      path: consumer.path,
      status: "pass",
      transition_last_sha256: transitionLastSha256,
      invocation_id: invocationId,
      replacement_fingerprint: replacementFingerprint,
      protected_assets_sha256: protectedAssetsSha256,
      contract_sha256: consumerContractSha256(policy, consumer),
      observed_at: observedAt,
    };
    return { ...evidence, evidence_sha256: consumerEvidenceSha256(evidence) };
  });
}

function pathExists(value) {
  try { lstatSync(value); return true; } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    refuse("filesystem_metadata_failed");
  }
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ensureTrustedStateDirectory(directory) {
  requireTrustedRootDirectory(directory, { modes: [0o700], label: "state_directory" });
}

function ensureEscrowDirectory(directory) {
  if (!pathExists(directory)) {
    mkdirSync(directory, { mode: 0o700 });
    chownSync(directory, 0, 0);
    chmodSync(directory, 0o700);
    fsyncDirectory(path.dirname(directory));
  }
  requireTrustedRootDirectory(directory, { modes: [0o700], label: "escrow_directory" });
}

function atomicRootWrite(file, bytes, { mode = 0o600, exclusive = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 2 * 1024 * 1024) refuse("durable_record_invalid");
  const directory = path.dirname(file);
  ensureTrustedStateDirectory(directory);
  if (exclusive && pathExists(file)) {
    const existing = readTrustedRootFile(file, { maximum: 2 * 1024 * 1024, modes: [mode], label: "durable_record" });
    if (existing.equals(bytes)) return;
    refuse("durable_record_already_exists");
  }
  const temporary = `${file}.next`;
  if (pathExists(temporary)) {
    let staged = null;
    try {
      staged = readTrustedRootFile(temporary, { maximum: 2 * 1024 * 1024, modes: [mode], label: "durable_staging" });
    } catch (error) {
      const metadata = lstatSync(temporary, { bigint: true });
      if (
        !metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.uid !== 0n || metadata.gid !== 0n || metadata.nlink !== 1n ||
        Number(metadata.mode & 0o777n) !== mode || metadata.size > BigInt(2 * 1024 * 1024)
      ) throw error;
      if (pathExists(file)) {
        readTrustedRootFile(file, { maximum: 2 * 1024 * 1024, modes: [mode], label: "durable_record" });
      }
      unlinkSync(temporary);
      fsyncDirectory(directory);
    }
    if (staged !== null) {
      if (pathExists(file)) {
        const existing = readTrustedRootFile(file, {
          maximum: 2 * 1024 * 1024,
          modes: [mode],
          label: "durable_record",
        });
        if (staged.equals(bytes)) {
          renameSync(temporary, file);
          fsyncDirectory(directory);
          return;
        }
        if (existing.equals(bytes)) {
          unlinkSync(temporary);
          fsyncDirectory(directory);
          return;
        }
      }
      if (staged.equals(bytes)) {
        renameSync(temporary, file);
        fsyncDirectory(directory);
        return;
      }
      const metadata = lstatSync(temporary, { bigint: true });
      if (
        !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0n ||
        metadata.gid !== 0n || metadata.nlink !== 1n ||
        Number(metadata.mode & 0o777n) !== mode || metadata.size > BigInt(2 * 1024 * 1024)
      ) refuse("durable_staging_conflict");
      unlinkSync(temporary);
      fsyncDirectory(directory);
    }
  }
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, mode);
    fchownSync(descriptor, 0, 0);
    fsyncSync(descriptor);
  } catch (error) {
    try { if (pathExists(temporary)) unlinkSync(temporary); } catch { /* keep the original fixed failure */ }
    refuse("durable_write_failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  renameSync(temporary, file);
  fsyncDirectory(directory);
}

function escrowKey(fingerprintKey, transactionId, nonce) {
  if (!Buffer.isBuffer(fingerprintKey) || fingerprintKey.length < 32) refuse("escrow_key_invalid");
  if (!UUID.test(transactionId) || !NONCE.test(nonce)) refuse("escrow_identity_invalid");
  return Buffer.from(hkdfSync(
    "sha256",
    fingerprintKey,
    Buffer.from(`${FINGERPRINT_DOMAIN}\0${transactionId}\0${nonce}`, "utf8"),
    Buffer.from("newme-credential-live-escrow/v1", "utf8"),
    32,
  ));
}

function escrowMetadata({ transactionId, nonce, claimSha256, createdAt, expiresAt, iv }) {
  return {
    version: ESCROW_VERSION,
    transaction_id: transactionId,
    nonce,
    claim_sha256: claimSha256,
    created_at: createdAt,
    expires_at: expiresAt,
    algorithm: "aes-256-gcm",
    iv,
  };
}

function sealedEscrowBytes({
  policy,
  fingerprintKey,
  transactionId,
  nonce,
  claimBytes,
  providerIdentityReceiptBytes,
  oldPat,
  oldService,
  replacementService,
  nowMs,
}) {
  const createdAt = isoAt(nowMs);
  const expiresAt = isoAt(nowMs + policy.escrow_ttl_seconds * 1000);
  const iv = randomBytes(12);
  const metadata = escrowMetadata({
    transactionId,
    nonce,
    claimSha256: sha256(claimBytes),
    createdAt,
    expiresAt,
    iv: iv.toString("base64url"),
  });
  const plaintext = canonicalCredentialJsonBytes({
    claim: Buffer.from(claimBytes).toString("base64url"),
    provider_identity_receipt: Buffer.from(providerIdentityReceiptBytes).toString("base64url"),
    old_pat: Buffer.from(oldPat).toString("base64url"),
    old_service: Buffer.from(oldService).toString("base64url"),
    replacement_service: Buffer.from(replacementService).toString("base64url"),
  });
  const cipher = createCipheriv("aes-256-gcm", escrowKey(fingerprintKey, transactionId, nonce), iv);
  cipher.setAAD(canonicalCredentialJsonBytes(metadata));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return canonicalCredentialJsonBytes({
    ...metadata,
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function parseSealedEscrow(bytes, {
  policy,
  fingerprintKey,
  transactionId,
  nonce,
  claimSha256,
  nowMs,
  allowExpired = false,
}) {
  const record = parseJsonBytes(bytes, "escrow_record_invalid");
  exactKeys(record, [
    "version", "transaction_id", "nonce", "claim_sha256", "created_at", "expires_at",
    "algorithm", "iv", "tag", "ciphertext",
  ], "escrow_record_invalid");
  if (
    record.version !== ESCROW_VERSION || record.transaction_id !== transactionId || record.nonce !== nonce ||
    record.claim_sha256 !== claimSha256 || record.algorithm !== "aes-256-gcm" ||
    !/^[A-Za-z0-9_-]{16}$/.test(record.iv) || !/^[A-Za-z0-9_-]{22}$/.test(record.tag) ||
    typeof record.ciphertext !== "string" || record.ciphertext.length < 16 || record.ciphertext.length > 131_072
  ) refuse("escrow_record_invalid");
  const created = timestampMs(record.created_at, "escrow_timestamp_invalid");
  const expires = timestampMs(record.expires_at, "escrow_timestamp_invalid");
  if ((!allowExpired && expires <= nowMs) || expires <= created || expires - created > policy.escrow_ttl_seconds * 1000) {
    refuse("escrow_expired");
  }
  const metadata = escrowMetadata({
    transactionId,
    nonce,
    claimSha256,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    iv: record.iv,
  });
  let plaintext;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      escrowKey(fingerprintKey, transactionId, nonce),
      Buffer.from(record.iv, "base64url"),
    );
    decipher.setAAD(canonicalCredentialJsonBytes(metadata));
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64url")),
      decipher.final(),
    ]);
  } catch {
    refuse("escrow_authentication_failed");
  }
  const values = parseJsonBytes(plaintext, "escrow_plaintext_invalid");
  exactKeys(values, [
    "claim", "provider_identity_receipt", "old_pat", "old_service", "replacement_service",
  ], "escrow_plaintext_invalid");
  const decode = (value, code, maximum) => {
    if (typeof value !== "string" || value.length < 1 || value.length > maximum * 2) refuse(code);
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value || decoded.length < 1 || decoded.length > maximum) refuse(code);
    return decoded;
  };
  const claimBytes = decode(values.claim, "escrow_claim_invalid", 65_536);
  if (sha256(claimBytes) !== claimSha256) refuse("escrow_claim_invalid");
  return {
    claimBytes,
    providerIdentityReceiptBytes: decode(
      values.provider_identity_receipt,
      "provider_identity_receipt_invalid",
      262_144,
    ),
    oldPat: parseSingleLineSecret(decode(values.old_pat, "old_pat_invalid", 4096), "old_pat_invalid"),
    oldService: parseSingleLineSecret(decode(values.old_service, "old_service_invalid", 4096), "old_service_invalid"),
    replacementService: parseSingleLineSecret(
      decode(values.replacement_service, "replacement_service_invalid", 4096),
      "replacement_service_invalid",
    ),
    createdAt: record.created_at,
    expiresAt: record.expires_at,
  };
}

function removeTrustedEscrowDirectory(directory) {
  requireTrustedRootDirectory(directory, { modes: [0o700], label: "escrow_staging_directory" });
  const entries = readdirSync(directory);
  for (const entry of entries) {
    if (![ESCROW_FILE, `${ESCROW_FILE}.next`].includes(entry)) refuse("escrow_staging_file_set_invalid");
    const file = path.join(directory, entry);
    const metadata = lstatSync(file, { bigint: true });
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0n || metadata.gid !== 0n ||
      metadata.nlink !== 1n || Number(metadata.mode & 0o777n) !== 0o600 || metadata.size > 2n * 1024n * 1024n
    ) refuse("escrow_staging_metadata_invalid");
  }
  rmSync(directory, { recursive: true });
  fsyncDirectory(path.dirname(directory));
}

export function writeCredentialEscrow({
  policy,
  fingerprintKey,
  transactionId,
  nonce,
  claimBytes,
  providerIdentityReceiptBytes,
  oldPat,
  oldService,
  replacementService,
  nowMs = Date.now(),
}) {
  const finalDirectory = policy.state.escrow_directory;
  const stagingDirectory = `${finalDirectory}.preparing`;
  const claimSha256 = sha256(claimBytes);
  const expected = { policy, fingerprintKey, transactionId, nonce, claimSha256, nowMs };
  const requireExactExisting = (existing) => {
    if (
      !existing.claimBytes.equals(claimBytes) || !existing.oldPat.equals(oldPat) ||
      !existing.providerIdentityReceiptBytes.equals(providerIdentityReceiptBytes) ||
      !existing.oldService.equals(oldService) || !existing.replacementService.equals(replacementService)
    ) refuse("escrow_existing_identity_mismatch");
    return existing;
  };
  ensureTrustedStateDirectory(path.dirname(finalDirectory));
  if (pathExists(finalDirectory)) {
    requireTrustedRootDirectory(finalDirectory, { modes: [0o700], label: "escrow_directory" });
    if (readdirSync(finalDirectory).length === 0) {
      rmdirSync(finalDirectory);
      fsyncDirectory(path.dirname(finalDirectory));
    } else {
      return requireExactExisting(readCredentialEscrow(expected));
    }
  }
  if (pathExists(stagingDirectory)) {
    try {
      requireTrustedRootDirectory(stagingDirectory, { modes: [0o700], label: "escrow_staging_directory" });
      const stagedBytes = readTrustedRootFile(path.join(stagingDirectory, ESCROW_FILE), {
        maximum: 2 * 1024 * 1024,
        modes: [0o600],
        label: "escrow_staging_record",
      });
      parseSealedEscrow(stagedBytes, expected);
      renameSync(stagingDirectory, finalDirectory);
      fsyncDirectory(path.dirname(finalDirectory));
      return requireExactExisting(readCredentialEscrow(expected));
    } catch (error) {
      if (pathExists(finalDirectory)) throw error;
      removeTrustedEscrowDirectory(stagingDirectory);
    }
  }
  mkdirSync(stagingDirectory, { mode: 0o700 });
  chownSync(stagingDirectory, 0, 0);
  chmodSync(stagingDirectory, 0o700);
  fsyncDirectory(path.dirname(stagingDirectory));
  const bytes = sealedEscrowBytes({
    policy, fingerprintKey, transactionId, nonce, claimBytes, providerIdentityReceiptBytes,
    oldPat, oldService, replacementService, nowMs,
  });
  atomicRootWrite(path.join(stagingDirectory, ESCROW_FILE), bytes, { mode: 0o600, exclusive: true });
  renameSync(stagingDirectory, finalDirectory);
  fsyncDirectory(path.dirname(finalDirectory));
  return requireExactExisting(readCredentialEscrow(expected));
}

export function readCredentialEscrow({ policy, fingerprintKey, transactionId, nonce, claimSha256, nowMs = Date.now() }) {
  const directory = policy.state.escrow_directory;
  requireTrustedRootDirectory(directory, { modes: [0o700], label: "escrow_directory" });
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([ESCROW_FILE])) {
    refuse("escrow_file_set_invalid");
  }
  const bytes = readTrustedRootFile(path.join(directory, ESCROW_FILE), {
    maximum: 2 * 1024 * 1024,
    modes: [0o600],
    label: "escrow_record",
  });
  return parseSealedEscrow(bytes, { policy, fingerprintKey, transactionId, nonce, claimSha256, nowMs });
}

function readCredentialEscrowForPreparedExpiry({
  policy,
  fingerprintKey,
  transactionId,
  nonce,
  claimSha256,
  nowMs,
}) {
  const directory = policy.state.escrow_directory;
  requireTrustedRootDirectory(directory, { modes: [0o700], label: "escrow_directory" });
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([ESCROW_FILE])) {
    refuse("escrow_file_set_invalid");
  }
  const bytes = readTrustedRootFile(path.join(directory, ESCROW_FILE), {
    maximum: 2 * 1024 * 1024,
    modes: [0o600],
    label: "escrow_record",
  });
  return parseSealedEscrow(bytes, {
    policy,
    fingerprintKey,
    transactionId,
    nonce,
    claimSha256,
    nowMs,
    allowExpired: true,
  });
}

export function deleteCredentialEscrow(policy) {
  const directory = policy.state.escrow_directory;
  if (!pathExists(directory)) return;
  requireTrustedRootDirectory(directory, { modes: [0o700], label: "escrow_directory" });
  const entries = readdirSync(directory).sort();
  if (entries.length === 0) {
    rmdirSync(directory);
    fsyncDirectory(path.dirname(directory));
    return;
  }
  if (JSON.stringify(entries) !== JSON.stringify([ESCROW_FILE])) {
    refuse("escrow_file_set_invalid");
  }
  unlinkSync(path.join(directory, ESCROW_FILE));
  fsyncDirectory(directory);
  rmdirSync(directory);
  fsyncDirectory(path.dirname(directory));
}

function readInstalledCredentialContext() {
  if (path.resolve(fileURLToPath(import.meta.url)) !== INSTALLED_HELPER_PATH) refuse("installed_helper_path_invalid");
  ensureTrustedStateDirectory("/var/lib/newme/deploy-state");
  const policyBytes = readTrustedRootFile(INSTALLED_POLICY_PATH, {
    maximum: 65_536,
    modes: [0o644],
    label: "installed_policy",
  });
  const policy = parseJsonBytes(policyBytes, "policy_json_invalid");
  validateCredentialLivePolicy(policy);
  const publicKeyBytes = readTrustedRootFile(policy.receipts.public_key_path, {
    maximum: 16_384,
    modes: [0o400, 0o600, 0o640, 0o644],
    label: "receipt_public_key",
  });
  const privateKeyBytes = readTrustedRootFile(policy.receipts.private_key_path, {
    maximum: 16_384,
    modes: [0o400, 0o600],
    label: "receipt_private_key",
  });
  const fingerprintKey = readTrustedRootFile(policy.fingerprints.key_path, {
    maximum: 4096,
    modes: [0o400, 0o600],
    label: "fingerprint_key",
  });
  const githubReader = parseSingleLineSecret(readTrustedRootFile(policy.inputs.github_reader_path, {
    maximum: 4096,
    modes: [0o400, 0o600],
    label: "github_reader",
  }), "github_reader_invalid");
  const githubSecretScanningReader = parseSingleLineSecret(readTrustedRootFile(
    policy.inputs.github_secret_scanning_reader_path,
    {
      maximum: 4096,
      modes: [0o400, 0o600],
      label: "github_secret_scanning_reader",
    },
  ), "github_secret_scanning_reader_invalid");
  const managementReader = parseSingleLineSecret(readTrustedRootFile(policy.inputs.management_reader_path, {
    maximum: 4096,
    modes: [0o400, 0o600],
    label: "management_reader",
  }), "management_reader_invalid");
  const keyDigests = publicKeyDigests(publicKeyBytes);
  if (
    keyDigests.file !== policy.receipts.public_key_file_sha256 ||
    keyDigests.spki !== policy.receipts.public_key_spki_sha256
  ) refuse("receipt_trust_binding_invalid");
  return {
    policy,
    publicKeyBytes,
    privateKeyBytes,
    fingerprintKey,
    githubReader,
    githubSecretScanningReader,
    managementReader,
  };
}

function secretLeakGuardFromContext({ oldPat, managementReader, oldService, replacementService }) {
  return {
    old_pat: oldPat,
    management_reader: managementReader,
    old_service: oldService,
    replacement_service: replacementService,
  };
}

function defaultRunCommand(command) {
  const result = spawnSync(command, [], {
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: "ignore",
    timeout: 60_000,
    windowsHide: true,
  });
  return result.error ? -1 : result.status;
}

export function transitionCredentialLiveState(state, event) {
  const transitions = {
    ABSENT: { prepare: "PREPARED" },
    PREPARED: { cutover: "CUTOVER_INFLIGHT", expire: "EXPIRED", integrity_failure: "FAILED" },
    CUTOVER_INFLIGHT: { attest: "COMPLETE", retry: "CUTOVER_INFLIGHT", integrity_failure: "FAILED" },
    COMPLETE: { consume: "CONSUMED" },
    CONSUMED: {},
    FAILED: {},
    EXPIRED: {},
  };
  const next = transitions[state]?.[event];
  if (!next) refuse("state_transition_invalid");
  return next;
}

const LIVE_STATE_KEYS = Object.freeze([
  "version", "state", "transaction_id", "nonce", "candidate_sha", "ci_run_id", "ci_run_attempt",
  "claim_sha256", "precheck_sha256", "revocation_proof_sha256", "completion_sha256",
  "readback_sha256", "tombstone_sha256", "release_sha", "updated_at",
]);

function readInstalledProtection(candidateSha) {
  const markerBytes = readTrustedRootFile(PROTECTION_MARKER_PATH, {
    maximum: 65_536,
    modes: [0o600],
    label: "protected_marker",
  });
  const assetBytesByPath = {};
  for (const [assetPath, mode] of Object.entries(PROTECTED_CONTROL_PLANE_ASSETS)) {
    assetBytesByPath[assetPath] = readTrustedRootFile(assetPath, {
      maximum: 2 * 1024 * 1024,
      modes: [mode],
      label: "protected_asset",
    });
  }
  const protection = validateInstalledProtectionMarker(markerBytes, { assetBytesByPath });
  if (protection.marker.candidate_sha !== candidateSha) refuse("protected_marker_candidate_mismatch");
  return protection;
}

function installedServiceInvocationId() {
  const result = spawnSync("/usr/bin/systemctl", [
    "show", "newme-platform.service", "-p", "InvocationID", "--value",
  ], {
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
    windowsHide: true,
  });
  const value = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.error || result.status !== 0 || !SAFE_ID.test(value)) refuse("service_invocation_read_failed");
  return value;
}

function measureInstalledControlPlane(candidateSha, expectedInvocationId) {
  const protection = readInstalledProtection(candidateSha);
  const invocationId = installedServiceInvocationId();
  if (invocationId !== expectedInvocationId) refuse("service_invocation_changed");
  return { protectedAssetsSha256: protection.sha256, invocationId };
}

function readLiveState(policy) {
  if (!pathExists(policy.state.journal_path)) return null;
  const record = parseJsonBytes(readTrustedRootFile(policy.state.journal_path, {
    maximum: 65_536,
    modes: [0o600],
    label: "credential_live_state",
  }), "credential_live_state_invalid");
  exactKeys(record, LIVE_STATE_KEYS, "credential_live_state_invalid");
  if (
    record.version !== LIVE_STATE_VERSION ||
    !["PREPARED", "CUTOVER_INFLIGHT", "COMPLETE", "CONSUMED", "FAILED", "EXPIRED"].includes(record.state) ||
    !UUID.test(record.transaction_id) || !NONCE.test(record.nonce) || !SHA40.test(record.candidate_sha) ||
    !RUN_ID.test(String(record.ci_run_id)) || !Number.isInteger(record.ci_run_attempt) || record.ci_run_attempt < 1 ||
    !SHA256.test(record.claim_sha256) || !SHA256.test(record.precheck_sha256) ||
    (record.revocation_proof_sha256 !== null && !SHA256.test(record.revocation_proof_sha256))
  ) refuse("credential_live_state_invalid");
  for (const field of ["revocation_proof_sha256", "completion_sha256", "readback_sha256", "tombstone_sha256"]) {
    if (record[field] !== null && !SHA256.test(record[field])) refuse("credential_live_state_invalid");
  }
  if (record.release_sha !== null && !SHA40.test(record.release_sha)) refuse("credential_live_state_invalid");
  timestampMs(record.updated_at, "credential_live_state_invalid");
  return record;
}

function liveStateRecord({
  state,
  claim,
  claimSha256,
  precheckSha256,
  previous = null,
  revocationProofSha256 = previous?.revocation_proof_sha256 ?? null,
  completionSha256 = previous?.completion_sha256 ?? null,
  readbackSha256 = previous?.readback_sha256 ?? null,
  tombstoneSha256 = previous?.tombstone_sha256 ?? null,
  releaseSha = previous?.release_sha ?? null,
  nowMs,
}) {
  return {
    version: LIVE_STATE_VERSION,
    state,
    transaction_id: claim.transaction_id,
    nonce: claim.nonce,
    candidate_sha: claim.candidate_sha,
    ci_run_id: claim.ci_run_id,
    ci_run_attempt: claim.ci_run_attempt,
    claim_sha256: claimSha256,
    precheck_sha256: precheckSha256,
    revocation_proof_sha256: revocationProofSha256,
    completion_sha256: completionSha256,
    readback_sha256: readbackSha256,
    tombstone_sha256: tombstoneSha256,
    release_sha: releaseSha,
    updated_at: isoAt(nowMs),
  };
}

function writeLiveState(policy, record) {
  atomicRootWrite(policy.state.journal_path, canonicalCredentialJsonBytes(record), { mode: 0o600 });
  return record;
}

function requireStateIdentity(state, claim, claimSha256, precheckSha256, allowedStates) {
  if (
    state === null || !allowedStates.includes(state.state) || state.transaction_id !== claim.transaction_id ||
    state.nonce !== claim.nonce || state.candidate_sha !== claim.candidate_sha ||
    state.ci_run_id !== claim.ci_run_id || state.ci_run_attempt !== claim.ci_run_attempt ||
    state.claim_sha256 !== claimSha256 || state.precheck_sha256 !== precheckSha256
  ) refuse("credential_live_state_identity_mismatch");
}

function readEvidenceFile(file, label, maximum = 2 * 1024 * 1024) {
  return parseJsonBytes(readTrustedRootFile(file, {
    maximum,
    modes: [0o600],
    label,
  }), `${label}_invalid`);
}

function distinctCredentialBytes(values) {
  const entries = Object.values(values);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (entries[left].equals(entries[right])) refuse("credential_replacement_not_distinct");
    }
  }
}

function requireCredentialSetMatchesClaim({ policy, fingerprintKey, claim, secrets }) {
  distinctCredentialBytes(secrets);
  for (const [kind, secretBytes] of Object.entries(secrets)) {
    requireCredentialFingerprint({
      policy,
      fingerprintKey,
      transactionId: claim.transaction_id,
      nonce: claim.nonce,
      credentialKind: kind,
      token: secretBytes,
      expectedFingerprint: claim.credentials[kind].fingerprint,
    });
  }
}

export function restorePreparedInput(file, bytes, { maximum, label, matches = (current) => current.equals(bytes) }) {
  if (pathExists(file)) {
    const current = readTrustedRootFile(file, {
      maximum,
      modes: [0o400, 0o600],
      label,
    });
    if (!matches(current)) refuse("prepared_input_identity_mismatch");
    return;
  }
  atomicRootWrite(file, bytes, { mode: 0o600, exclusive: true });
}

export function verifyInstalledPrecheck({ candidateSha, runId, runAttempt, serviceInvocationId, nowMs = Date.now() }) {
  if (!SHA40.test(candidateSha) || !RUN_ID.test(runId) || !Number.isInteger(runAttempt) || runAttempt < 1) {
    refuse("precheck_expected_identity_invalid");
  }
  assertSafeId(serviceInvocationId, "precheck_service_invocation_invalid");
  if (path.resolve(fileURLToPath(import.meta.url)) !== INSTALLED_HELPER_PATH) refuse("installed_helper_path_invalid");

  requireTrustedRootDirectory("/var/lib/newme/deploy-state", { modes: [0o700], label: "state_directory" });
  requireTrustedRootDirectory("/run/newme-credential-live-input", { modes: [0o700], label: "live_input_directory" });
  requireTrustedRootDirectory("/run/newme-credential-inbox", { modes: [0o700], label: "credential_inbox_directory" });
  requireTrustedRootDirectory("/etc/newme", { modes: [0o700, 0o750], label: "runtime_directory" });

  const markerBytes = readTrustedRootFile(PROTECTION_MARKER_PATH, {
    maximum: 65_536,
    modes: [0o600],
    label: "protected_marker",
  });
  const assetBytesByPath = {};
  for (const [assetPath, mode] of Object.entries(PROTECTED_CONTROL_PLANE_ASSETS)) {
    assetBytesByPath[assetPath] = readTrustedRootFile(assetPath, {
      maximum: 2 * 1024 * 1024,
      modes: [mode],
      label: "protected_asset",
    });
  }
  const protection = validateInstalledProtectionMarker(markerBytes, { assetBytesByPath });
  if (protection.marker.candidate_sha !== candidateSha) refuse("protected_marker_candidate_mismatch");
  const policyBytes = readTrustedRootFile(INSTALLED_POLICY_PATH, {
    maximum: 65_536,
    modes: [0o644],
    label: "installed_policy",
  });
  const policy = parseJsonBytes(policyBytes, "policy_json_invalid");
  validateCredentialLivePolicy(policy);

  const publicKeyBytes = readTrustedRootFile(policy.receipts.public_key_path, {
    maximum: 16_384,
    modes: [0o400, 0o600, 0o640, 0o644],
    label: "receipt_public_key",
  });
  const keyDigests = publicKeyDigests(publicKeyBytes);
  if (
    keyDigests.file !== policy.receipts.public_key_file_sha256 ||
    keyDigests.spki !== policy.receipts.public_key_spki_sha256
  ) refuse("receipt_trust_binding_invalid");

  const claimBytes = readTrustedRootFile(policy.inputs.claim_path, {
    maximum: 65_536,
    modes: [0o400, 0o600],
    label: "credential_claim",
  });
  const precheckBytes = readTrustedRootFile(policy.state.precheck_path, {
    maximum: 1024 * 1024,
    modes: [0o600],
    label: "credential_precheck",
  });
  const claim = parseJsonBytes(claimBytes, "claim_json_invalid");
  const precheck = parseJsonBytes(precheckBytes, "precheck_json_invalid");
  validateCredentialClaim(claim, policy, { nowMs });
  if (
    claim.candidate_sha !== candidateSha || claim.ci_run_id !== runId ||
    claim.ci_run_attempt !== runAttempt
  ) refuse("claim_expected_identity_mismatch");

  const runtimeBytes = readTrustedRootFile(RUNTIME_ENV_PATH, {
    maximum: 262_144,
    modes: [0o600],
    label: "runtime",
  });
  const fingerprintKey = readTrustedRootFile(policy.fingerprints.key_path, {
    maximum: 4096,
    modes: [0o400, 0o600],
    label: "fingerprint_key",
  });
  const secretBytesByKind = {
    old_pat: parseSingleLineSecret(readTrustedRootFile(policy.inputs.old_pat_path, {
      maximum: 4096,
      modes: [0o400, 0o600],
      label: "old_pat",
    }), "old_pat_invalid"),
    management_reader: parseSingleLineSecret(readTrustedRootFile(policy.inputs.management_reader_path, {
      maximum: 4096,
      modes: [0o400, 0o600],
      label: "management_reader",
    }), "management_reader_invalid"),
    old_service: parseRuntimeServiceKey(runtimeBytes),
    replacement_service: parseRuntimeServiceKey(readTrustedRootFile(policy.inputs.replacement_service_path, {
      maximum: 4096,
      modes: [0o400, 0o600],
      label: "replacement_service",
    })),
  };
  const secretValues = Object.values(secretBytesByKind);
  for (let left = 0; left < secretValues.length; left += 1) {
    for (let right = left + 1; right < secretValues.length; right += 1) {
      if (secretValues[left].equals(secretValues[right])) refuse("credential_replacement_not_distinct");
    }
  }
  for (const [kind, secretBytes] of Object.entries(secretBytesByKind)) {
    const actual = credentialFingerprint({
      keyBytes: fingerprintKey,
      keyId: policy.fingerprints.key_id,
      transactionId: claim.transaction_id,
      nonce: claim.nonce,
      kind,
      secretBytes,
    });
    if (claim.credentials[kind].fingerprint !== actual) refuse("claim_credential_fingerprint_mismatch");
  }

  const result = validatePrecheck(precheck, { policy, publicKeyBytes, claim, nowMs });
  if (
    precheck.transition_before_sha256 !== sha256(runtimeBytes) ||
    precheck.protected_assets_sha256 !== protection.sha256 ||
    precheck.pre_cutover_invocation_id !== serviceInvocationId
  ) refuse("precheck_live_state_mismatch");
  return {
    transactionId: claim.transaction_id,
    precheckSha256: result.sha256,
    runAttempt,
    protectedAssetsSha256: protection.sha256,
    transitionBeforeSha256: precheck.transition_before_sha256,
    transitionAfterSha256: sha256(renderRuntimeServiceKey(
      runtimeBytes,
      secretBytesByKind.replacement_service,
    )),
  };
}

function requireExpectedLiveArguments({ candidateSha, runId, runAttempt, invocationId }) {
  if (
    !SHA40.test(candidateSha) || !RUN_ID.test(String(runId)) ||
    !Number.isInteger(runAttempt) || runAttempt < 1 || !SAFE_ID.test(invocationId)
  ) refuse("live_command_identity_invalid");
}

function readProviderMaterializationIntent({
  candidateSha,
  runId,
  runAttempt,
  invocationId,
  nowMs,
  allowExpired = false,
}) {
  if (!pathExists(PROVIDER_MATERIALIZATION_INTENT_PATH)) return null;
  const bytes = readTrustedRootFile(PROVIDER_MATERIALIZATION_INTENT_PATH, {
    maximum: 65_536,
    modes: [0o600],
    label: "provider_materialization_intent",
  });
  const intent = parseJsonBytes(bytes, "provider_materialization_intent_invalid");
  exactKeys(intent, [
    "version", "candidate_sha", "ci_run_id", "ci_run_attempt", "pre_cutover_invocation_id",
    "transaction_id", "nonce", "provider_object_id", "created_at", "expires_at",
  ], "provider_materialization_intent_invalid");
  const created = timestampMs(intent.created_at, "provider_materialization_intent_expired");
  const expires = timestampMs(intent.expires_at, "provider_materialization_intent_expired");
  const expired = expires <= nowMs;
  if (
    intent.version !== PROVIDER_MATERIALIZATION_INTENT_VERSION ||
    intent.candidate_sha !== candidateSha || intent.ci_run_id !== String(runId) ||
    intent.ci_run_attempt !== runAttempt || intent.pre_cutover_invocation_id !== invocationId ||
    !UUID.test(intent.transaction_id) || !NONCE.test(intent.nonce) ||
    intent.provider_object_id.length < 1 || created > nowMs + 60_000 || expires <= created ||
    expires - created > 900_000
  ) refuse("provider_materialization_intent_invalid");
  if (!allowExpired && (expired || created < nowMs - 900_000)) {
    refuse("provider_materialization_intent_expired");
  }
  assertNonSecretProviderId(intent.provider_object_id, "provider_materialization_intent_invalid");
  return { intent, bytes, expired };
}

function createProviderMaterializationIntent({
  candidateSha,
  runId,
  runAttempt,
  invocationId,
  providerObjectId,
  nowMs,
}) {
  const intent = {
    version: PROVIDER_MATERIALIZATION_INTENT_VERSION,
    candidate_sha: candidateSha,
    ci_run_id: String(runId),
    ci_run_attempt: runAttempt,
    pre_cutover_invocation_id: invocationId,
    transaction_id: randomUUID(),
    nonce: randomBytes(32).toString("base64url"),
    provider_object_id: providerObjectId,
    created_at: isoAt(nowMs),
    expires_at: isoAt(nowMs + 900_000),
  };
  const bytes = canonicalCredentialJsonBytes(intent);
  atomicRootWrite(PROVIDER_MATERIALIZATION_INTENT_PATH, bytes, { mode: 0o600, exclusive: true });
  return { intent, bytes };
}

function providerIdentityBinding({ policy, claim, result }) {
  const replacement = claim.credentials.replacement_service;
  return {
    operation: "get-exact-api-key-reveal",
    endpoint_contract_sha256: providerIdentityEndpointContractSha256(
      policy,
      replacement.provider_object_id,
    ),
    project_ref: policy.project_ref,
    provider_object_id: replacement.provider_object_id,
    provider_kind: policy.credential_identities.replacement_service.provider_kind,
    scope_id: replacement.scope_id,
    fingerprint: replacement.fingerprint,
    status: result.status,
    observed_at: result.observedAt,
    provider_date: result.providerDate,
    request_id: result.requestId,
  };
}

export async function materializeInstalledProviderIdentity({
  candidateSha,
  runId,
  runAttempt,
  preCutoverInvocationId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  checkpoint = () => {},
}) {
  if (typeof checkpoint !== "function") refuse("provider_materialization_checkpoint_invalid");
  requireExpectedLiveArguments({
    candidateSha,
    runId,
    runAttempt,
    invocationId: preCutoverInvocationId,
  });
  const context = readInstalledCredentialContext();
  const { policy } = context;
  if (
    pathExists(policy.state.consumed_path) || readLiveState(policy) !== null ||
    pathExists(TRANSITION_PENDING_PATH) || pathExists(TRANSITION_BACKUP_PATH)
  ) refuse("provider_materialization_state_conflict");
  const protection = readInstalledProtection(candidateSha);
  if (installedServiceInvocationId() !== preCutoverInvocationId) refuse("service_invocation_changed");
  const startedMs = now();
  const providerObjectId = policy.credential_identities.replacement_service.provider_object_id;
  const providerKind = policy.credential_identities.replacement_service.provider_kind;
  if (providerKind !== "secret") refuse("provider_materialization_kind_invalid");

  let claim = null;
  let claimBytes = null;
  let intentRecord = null;
  const escrowExistedAtStart = pathExists(policy.state.escrow_directory);
  if (pathExists(policy.inputs.claim_path)) {
    claimBytes = readTrustedRootFile(policy.inputs.claim_path, {
      maximum: 65_536,
      modes: [0o400, 0o600],
      label: "credential_claim",
    });
    claim = parseJsonBytes(claimBytes, "claim_json_invalid");
    intentRecord = readProviderMaterializationIntent({
      candidateSha,
      runId,
      runAttempt,
      invocationId: preCutoverInvocationId,
      nowMs: startedMs,
      allowExpired: true,
    });
  } else {
    intentRecord = readProviderMaterializationIntent({
      candidateSha,
      runId,
      runAttempt,
      invocationId: preCutoverInvocationId,
      nowMs: startedMs,
      allowExpired: true,
    }) ?? createProviderMaterializationIntent({
      candidateSha,
      runId,
      runAttempt,
      invocationId: preCutoverInvocationId,
      providerObjectId,
      nowMs: startedMs,
    });
    checkpoint("after_intent");
  }

  if (intentRecord?.expired && !escrowExistedAtStart) {
    if (
      pathExists(policy.inputs.claim_path) ||
      pathExists(policy.inputs.provider_identity_receipt_path) ||
      pathExists(policy.inputs.replacement_service_path)
    ) refuse("provider_materialization_expired_without_escrow");
    removeTrustedRootFileMatching(PROVIDER_MATERIALIZATION_INTENT_PATH, {
      maximum: 65_536,
      modes: [0o600],
      label: "provider_materialization_intent",
      matches: (bytes) => bytes.equals(intentRecord.bytes),
    });
    intentRecord = createProviderMaterializationIntent({
      candidateSha,
      runId,
      runAttempt,
      invocationId: preCutoverInvocationId,
      providerObjectId,
      nowMs: startedMs,
    });
    checkpoint("after_expired_intent_cleanup");
  }

  const result = await fetchProviderJson({
    fetchImpl,
    url: `${policy.supabase_management_origin}${policy.provider_keys_path}/${providerObjectId}?reveal=true`,
    headers: patHeaders(policy, parseSingleLineSecret(readTrustedRootFile(policy.inputs.old_pat_path, {
      maximum: 4096,
      modes: [0o400, 0o600],
      label: "old_pat",
    }), "old_pat_invalid")),
    policy,
    nowMs: now,
    label: "supabase_exact_key",
  });
  if (
    result.status !== 200 || !object(result.body) || result.body.id !== providerObjectId ||
    result.body.type !== providerKind || typeof result.body.api_key !== "string"
  ) refuse("provider_materialization_response_invalid");
  checkpoint("after_provider_fetch");
  const replacementService = parseSingleLineSecret(
    Buffer.from(result.body.api_key, "utf8"),
    "replacement_service_invalid",
  );
  if (!replacementService.toString("utf8").startsWith("sb_secret_")) {
    refuse("replacement_service_invalid");
  }
  const runtimeBytes = readTrustedRootFile(RUNTIME_ENV_PATH, {
    maximum: 262_144,
    modes: [0o600],
    label: "runtime",
  });
  const secrets = {
    old_pat: parseSingleLineSecret(readTrustedRootFile(policy.inputs.old_pat_path, {
      maximum: 4096,
      modes: [0o400, 0o600],
      label: "old_pat",
    }), "old_pat_invalid"),
    management_reader: context.managementReader,
    old_service: parseRuntimeServiceKey(runtimeBytes),
    replacement_service: replacementService,
  };
  distinctCredentialBytes(secrets);

  if (claim === null) {
    const { intent } = intentRecord;
    claim = {
      version: CLAIM_VERSION,
      transaction_id: intent.transaction_id,
      nonce: intent.nonce,
      candidate_sha: candidateSha,
      ci_run_id: String(runId),
      ci_run_attempt: runAttempt,
      created_at: intent.created_at,
      expires_at: intent.expires_at,
      credentials: createCredentialIdentities({
        policy,
        fingerprintKey: context.fingerprintKey,
        transactionId: intent.transaction_id,
        nonce: intent.nonce,
        secretBytesByKind: secrets,
      }),
    };
    claimBytes = canonicalCredentialJsonBytes(claim);
  }

  if (intentRecord?.expired && escrowExistedAtStart) {
    const historicalNowMs = timestampMs(
      intentRecord.intent.expires_at,
      "provider_materialization_intent_expired",
    ) - 1;
    validateCredentialClaim(claim, policy, { nowMs: historicalNowMs });
    requireCredentialSetMatchesClaim({
      policy,
      fingerprintKey: context.fingerprintKey,
      claim,
      secrets,
    });
    const expiredEscrow = readCredentialEscrowForPreparedExpiry({
      policy,
      fingerprintKey: context.fingerprintKey,
      transactionId: claim.transaction_id,
      nonce: claim.nonce,
      claimSha256: sha256(claimBytes),
      nowMs: historicalNowMs,
    });
    if (
      !expiredEscrow.claimBytes.equals(claimBytes) ||
      !expiredEscrow.oldPat.equals(secrets.old_pat) ||
      !expiredEscrow.oldService.equals(secrets.old_service) ||
      !expiredEscrow.replacementService.equals(secrets.replacement_service)
    ) refuse("provider_materialization_escrow_mismatch");
    const expiredReceipt = parseJsonBytes(
      expiredEscrow.providerIdentityReceiptBytes,
      "provider_identity_receipt_invalid",
    );
    validateProviderIdentityReceipt(expiredReceipt, {
      policy,
      publicKeyBytes: context.publicKeyBytes,
      claim,
      nowMs: historicalNowMs,
    });
    if (pathExists(policy.inputs.claim_path)) {
      removeTrustedRootFileMatching(policy.inputs.claim_path, {
        maximum: 65_536,
        modes: [0o400, 0o600],
        label: "credential_claim",
        matches: (bytes) => bytes.equals(claimBytes),
      });
    }
    if (pathExists(policy.inputs.provider_identity_receipt_path)) {
      removeTrustedRootFileMatching(policy.inputs.provider_identity_receipt_path, {
        maximum: 262_144,
        modes: [0o400, 0o600],
        label: "provider_identity_receipt",
        matches: (bytes) => bytes.equals(expiredEscrow.providerIdentityReceiptBytes),
      });
    }
    if (pathExists(policy.inputs.replacement_service_path)) {
      removeTrustedRootFileMatching(policy.inputs.replacement_service_path, {
        maximum: 4096,
        modes: [0o400, 0o600],
        label: "replacement_service",
        matches: (bytes) => parseRuntimeServiceKey(bytes).equals(secrets.replacement_service),
      });
    }
    deleteCredentialEscrow(policy);
    removeTrustedRootFileMatching(PROVIDER_MATERIALIZATION_INTENT_PATH, {
      maximum: 65_536,
      modes: [0o600],
      label: "provider_materialization_intent",
      matches: (bytes) => bytes.equals(intentRecord.bytes),
    });
    intentRecord = createProviderMaterializationIntent({
      candidateSha,
      runId,
      runAttempt,
      invocationId: preCutoverInvocationId,
      providerObjectId,
      nowMs: startedMs,
    });
    const { intent } = intentRecord;
    claim = {
      version: CLAIM_VERSION,
      transaction_id: intent.transaction_id,
      nonce: intent.nonce,
      candidate_sha: candidateSha,
      ci_run_id: String(runId),
      ci_run_attempt: runAttempt,
      created_at: intent.created_at,
      expires_at: intent.expires_at,
      credentials: createCredentialIdentities({
        policy,
        fingerprintKey: context.fingerprintKey,
        transactionId: intent.transaction_id,
        nonce: intent.nonce,
        secretBytesByKind: secrets,
      }),
    };
    claimBytes = canonicalCredentialJsonBytes(claim);
    checkpoint("after_expired_escrow_cleanup");
  }
  validateCredentialClaim(claim, policy, { nowMs: startedMs });
  if (
    claim.candidate_sha !== candidateSha || claim.ci_run_id !== String(runId) ||
    claim.ci_run_attempt !== runAttempt ||
    claim.credentials.replacement_service.provider_object_id !== providerObjectId
  ) refuse("claim_expected_identity_mismatch");
  requireCredentialSetMatchesClaim({
    policy,
    fingerprintKey: context.fingerprintKey,
    claim,
    secrets,
  });

  let existingEscrow = null;
  if (pathExists(policy.state.escrow_directory)) {
    existingEscrow = readCredentialEscrow({
      policy,
      fingerprintKey: context.fingerprintKey,
      transactionId: claim.transaction_id,
      nonce: claim.nonce,
      claimSha256: sha256(claimBytes),
      nowMs: startedMs,
    });
    if (
      !existingEscrow.claimBytes.equals(claimBytes) ||
      !existingEscrow.oldPat.equals(secrets.old_pat) ||
      !existingEscrow.oldService.equals(secrets.old_service) ||
      !existingEscrow.replacementService.equals(secrets.replacement_service)
    ) refuse("provider_materialization_escrow_mismatch");
  }

  let providerIdentityReceipt;
  let providerIdentityReceiptBytes;
  if (pathExists(policy.inputs.provider_identity_receipt_path)) {
    providerIdentityReceiptBytes = readTrustedRootFile(policy.inputs.provider_identity_receipt_path, {
      maximum: 262_144,
      modes: [0o400, 0o600],
      label: "provider_identity_receipt",
    });
    providerIdentityReceipt = parseJsonBytes(
      providerIdentityReceiptBytes,
      "provider_identity_receipt_invalid",
    );
  } else if (existingEscrow !== null) {
    providerIdentityReceiptBytes = existingEscrow.providerIdentityReceiptBytes;
    providerIdentityReceipt = parseJsonBytes(
      providerIdentityReceiptBytes,
      "provider_identity_receipt_invalid",
    );
  } else {
    const issuedMs = Date.parse(result.observedAt);
    providerIdentityReceipt = signCredentialEvidence({
      document: {
        version: PROVIDER_IDENTITY_RECEIPT_VERSION,
        purpose: "provider_identity",
        policy_sha256: policySha256(policy),
        claim_sha256: sha256(claimBytes),
        candidate_sha: candidateSha,
        transaction_id: claim.transaction_id,
        nonce: claim.nonce,
        credentials: structuredClone(claim.credentials),
        provider_binding: providerIdentityBinding({ policy, claim, result }),
        issued_at: isoAt(issuedMs),
        expires_at: claim.expires_at,
      },
      privateKeyBytes: context.privateKeyBytes,
      publicKeyBytes: context.publicKeyBytes,
      signedAt: isoAt(issuedMs),
      secretLeakGuard: secretLeakGuardFromContext({
        oldPat: secrets.old_pat,
        managementReader: secrets.management_reader,
        oldService: secrets.old_service,
        replacementService: secrets.replacement_service,
      }),
    });
    providerIdentityReceiptBytes = canonicalCredentialJsonBytes(providerIdentityReceipt);
  }
  const receiptResult = validateProviderIdentityReceipt(providerIdentityReceipt, {
    policy,
    publicKeyBytes: context.publicKeyBytes,
    claim,
    nowMs: startedMs,
  });
  writeCredentialEscrow({
    policy,
    fingerprintKey: context.fingerprintKey,
    transactionId: claim.transaction_id,
    nonce: claim.nonce,
    claimBytes,
    providerIdentityReceiptBytes,
    oldPat: secrets.old_pat,
    oldService: secrets.old_service,
    replacementService: secrets.replacement_service,
    nowMs: startedMs,
  });
  checkpoint("after_escrow");
  restorePreparedInput(policy.inputs.claim_path, claimBytes, {
    maximum: 65_536,
    label: "credential_claim",
  });
  checkpoint("after_claim");
  restorePreparedInput(
    policy.inputs.provider_identity_receipt_path,
    providerIdentityReceiptBytes,
    { maximum: 262_144, label: "provider_identity_receipt" },
  );
  checkpoint("after_receipt");
  restorePreparedInput(
    policy.inputs.replacement_service_path,
    Buffer.from(`SUPABASE_SERVICE_ROLE_KEY=${replacementService.toString("utf8")}\n`, "utf8"),
    {
      maximum: 4096,
      label: "replacement_service",
      matches: (bytes) => parseRuntimeServiceKey(bytes).equals(replacementService),
    },
  );
  checkpoint("after_replacement");
  if (intentRecord !== null && pathExists(PROVIDER_MATERIALIZATION_INTENT_PATH)) {
    removeTrustedRootFileMatching(PROVIDER_MATERIALIZATION_INTENT_PATH, {
      maximum: 65_536,
      modes: [0o600],
      label: "provider_materialization_intent",
      matches: (bytes) => bytes.equals(intentRecord.bytes),
    });
  }
  checkpoint("after_intent_cleanup");
  if (
    readInstalledProtection(candidateSha).sha256 !== protection.sha256 ||
    installedServiceInvocationId() !== preCutoverInvocationId
  ) refuse("provider_materialization_control_plane_changed");
  return {
    transactionId: claim.transaction_id,
    providerIdentityReceiptSha256: receiptResult.sha256,
  };
}

function preparedExpiryCleanupPending(policy) {
  return [
    policy.inputs.claim_path,
    `${policy.inputs.claim_path}.credential-consume`,
    policy.inputs.provider_identity_receipt_path,
    `${policy.inputs.provider_identity_receipt_path}.credential-consume`,
    policy.inputs.old_pat_path,
    `${policy.inputs.old_pat_path}.credential-consume`,
    policy.inputs.replacement_service_path,
    `${policy.inputs.replacement_service_path}.credential-consume`,
    policy.state.precheck_path,
    `${policy.state.precheck_path}.credential-consume`,
    policy.state.escrow_directory,
  ].some(pathExists);
}

export async function prepareInstalledCredentialAttestation({
  candidateSha,
  runId,
  runAttempt,
  preCutoverInvocationId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  requireExpectedLiveArguments({ candidateSha, runId, runAttempt, invocationId: preCutoverInvocationId });
  const context = readInstalledCredentialContext();
  const { policy } = context;
  if (pathExists(policy.state.consumed_path)) refuse("credential_attestation_already_consumed");
  const protection = readInstalledProtection(candidateSha);
  if (installedServiceInvocationId() !== preCutoverInvocationId) refuse("service_invocation_changed");
  const startedMs = now();
  const recordedState = readLiveState(policy);
  if (recordedState?.state === "EXPIRED" && preparedExpiryCleanupPending(policy)) {
    refuse("credential_prepared_expiry_cleanup_required");
  }
  const previousState = recordedState?.state === "EXPIRED" ? null : recordedState;
  if (previousState !== null && (
    previousState.state !== "PREPARED" || previousState.candidate_sha !== candidateSha ||
    previousState.ci_run_id !== String(runId) || previousState.ci_run_attempt !== runAttempt
  )) refuse("credential_live_state_identity_mismatch");
  const runtimeBytes = readTrustedRootFile(RUNTIME_ENV_PATH, {
    maximum: 262_144,
    modes: [0o600],
    label: "runtime",
  });
  let claim;
  let claimBytes;
  let providerIdentityReceiptBytes;
  let secrets;
  if (previousState !== null) {
    const escrow = readCredentialEscrow({
      policy,
      fingerprintKey: context.fingerprintKey,
      transactionId: previousState.transaction_id,
      nonce: previousState.nonce,
      claimSha256: previousState.claim_sha256,
      nowMs: startedMs,
    });
    claimBytes = escrow.claimBytes;
    claim = parseJsonBytes(claimBytes, "claim_json_invalid");
    providerIdentityReceiptBytes = escrow.providerIdentityReceiptBytes;
    secrets = {
      old_pat: escrow.oldPat,
      management_reader: context.managementReader,
      old_service: escrow.oldService,
      replacement_service: escrow.replacementService,
    };
    if (!parseRuntimeServiceKey(runtimeBytes).equals(secrets.old_service)) {
      refuse("prepared_runtime_identity_mismatch");
    }
    restorePreparedInput(policy.inputs.claim_path, claimBytes, {
      maximum: 65_536,
      label: "credential_claim",
    });
    restorePreparedInput(
      policy.inputs.provider_identity_receipt_path,
      providerIdentityReceiptBytes,
      { maximum: 262_144, label: "provider_identity_receipt" },
    );
    restorePreparedInput(
      policy.inputs.old_pat_path,
      Buffer.concat([secrets.old_pat, Buffer.from("\n", "utf8")]),
      {
        maximum: 4096,
        label: "old_pat",
        matches: (bytes) => parseSingleLineSecret(bytes, "old_pat_invalid").equals(secrets.old_pat),
      },
    );
    restorePreparedInput(
      policy.inputs.replacement_service_path,
      Buffer.from(`SUPABASE_SERVICE_ROLE_KEY=${secrets.replacement_service.toString("utf8")}\n`, "utf8"),
      {
        maximum: 4096,
        label: "replacement_service",
        matches: (bytes) => parseRuntimeServiceKey(bytes).equals(secrets.replacement_service),
      },
    );
  } else {
    secrets = {
      old_pat: parseSingleLineSecret(readTrustedRootFile(policy.inputs.old_pat_path, {
        maximum: 4096,
        modes: [0o400, 0o600],
        label: "old_pat",
      }), "old_pat_invalid"),
      management_reader: context.managementReader,
      old_service: parseRuntimeServiceKey(runtimeBytes),
      replacement_service: parseRuntimeServiceKey(readTrustedRootFile(policy.inputs.replacement_service_path, {
        maximum: 4096,
        modes: [0o400, 0o600],
        label: "replacement_service",
      })),
    };
    if (pathExists(policy.inputs.claim_path)) {
      claimBytes = readTrustedRootFile(policy.inputs.claim_path, {
        maximum: 65_536,
        modes: [0o400, 0o600],
        label: "credential_claim",
      });
      claim = parseJsonBytes(claimBytes, "claim_json_invalid");
    } else {
      const transactionId = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      claim = {
        version: CLAIM_VERSION,
        transaction_id: transactionId,
        nonce,
        candidate_sha: candidateSha,
        ci_run_id: String(runId),
        ci_run_attempt: runAttempt,
        created_at: isoAt(startedMs),
        expires_at: isoAt(startedMs + policy.precheck_ttl_seconds * 1000),
        credentials: createCredentialIdentities({
          policy,
          fingerprintKey: context.fingerprintKey,
          transactionId,
          nonce,
          secretBytesByKind: secrets,
        }),
      };
      claimBytes = canonicalCredentialJsonBytes(claim);
      atomicRootWrite(policy.inputs.claim_path, claimBytes, { mode: 0o600, exclusive: true });
    }
    if (!pathExists(policy.inputs.provider_identity_receipt_path)) {
      refuse("provider_identity_receipt_required");
    }
    providerIdentityReceiptBytes = readTrustedRootFile(policy.inputs.provider_identity_receipt_path, {
      maximum: 262_144,
      modes: [0o400, 0o600],
      label: "provider_identity_receipt",
    });
  }
  distinctCredentialBytes(secrets);
  validateCredentialClaim(claim, policy, { nowMs: startedMs });
  if (
    claim.candidate_sha !== candidateSha || claim.ci_run_id !== String(runId) ||
    claim.ci_run_attempt !== runAttempt
  ) refuse("claim_expected_identity_mismatch");
  requireCredentialSetMatchesClaim({ policy, fingerprintKey: context.fingerprintKey, claim, secrets });
  const claimSha = sha256(canonicalCredentialJsonBytes(claim));
  const providerIdentityReceipt = parseJsonBytes(
    providerIdentityReceiptBytes,
    "provider_identity_receipt_invalid",
  );
  validateProviderIdentityReceipt(providerIdentityReceipt, {
    policy,
    publicKeyBytes: context.publicKeyBytes,
    claim,
    nowMs: startedMs,
  });
  writeCredentialEscrow({
    policy,
    fingerprintKey: context.fingerprintKey,
    transactionId: claim.transaction_id,
    nonce: claim.nonce,
    claimBytes: canonicalCredentialJsonBytes(claim),
    providerIdentityReceiptBytes,
    oldPat: secrets.old_pat,
    oldService: secrets.old_service,
    replacementService: secrets.replacement_service,
    nowMs: startedMs,
  });
  let precheck;
  let precheckMustBeIssued = true;
  if (pathExists(policy.state.precheck_path)) {
    precheck = readEvidenceFile(policy.state.precheck_path, "credential_precheck");
    validatePrecheck(precheck, { policy, publicKeyBytes: context.publicKeyBytes, claim, nowMs: startedMs });
    if (previousState !== null) {
      requireStateIdentity(
        previousState,
        claim,
        claimSha,
        sha256(canonicalCredentialJsonBytes(precheck)),
        ["PREPARED"],
      );
    }
    if (
      precheck.transition_before_sha256 !== sha256(runtimeBytes) ||
      precheck.protected_assets_sha256 !== protection.sha256
    ) refuse("precheck_live_state_mismatch");
    precheckMustBeIssued = precheck.pre_cutover_invocation_id !== preCutoverInvocationId;
  } else if (previousState !== null) {
    refuse("credential_live_state_identity_mismatch");
  }
  const ci = await collectCiEvidence({
    fetchImpl, policy, token: context.githubReader, candidateSha, runId: String(runId), runAttempt, nowMs: now,
  });
  const github = await collectGithubEvidence({
    fetchImpl, policy, token: context.githubSecretScanningReader, requiredState: "open", nowMs: now,
  });
  const supabase = await collectSupabaseEvidence({
    fetchImpl,
    policy,
    token: context.managementReader,
    credentials: claim.credentials,
    stage: "precheck",
    nowMs: now,
    providerIdentityReceipt,
    publicKeyBytes: context.publicKeyBytes,
    claim,
  });
  const positiveControls = await collectPositiveControls({
    fetchImpl,
    policy,
    credentials: claim.credentials,
    secretBytesByKind: secrets,
    fingerprintKey: context.fingerprintKey,
    transactionId: claim.transaction_id,
    nonce: claim.nonce,
    nowMs: now,
  });
  const finalControlPlane = measureInstalledControlPlane(candidateSha, preCutoverInvocationId);
  if (finalControlPlane.protectedAssetsSha256 !== protection.sha256) refuse("protected_assets_changed");
  if (precheckMustBeIssued) {
    const issuedMs = now();
    precheck = signCredentialEvidence({
      document: {
        version: PRECHECK_VERSION,
        purpose: "precheck",
        transaction_id: claim.transaction_id,
        nonce: claim.nonce,
        policy_sha256: policySha256(policy),
        claim_sha256: claimSha,
        candidate_sha: candidateSha,
        ci,
        transition_before_sha256: sha256(runtimeBytes),
        credentials: claim.credentials,
        positive_controls: positiveControls,
        protected_assets_sha256: protection.sha256,
        pre_cutover_invocation_id: preCutoverInvocationId,
        github,
        supabase,
        issued_at: isoAt(issuedMs),
        expires_at: claim.expires_at,
      },
      privateKeyBytes: context.privateKeyBytes,
      publicKeyBytes: context.publicKeyBytes,
      signedAt: isoAt(issuedMs),
      secretLeakGuard: secretLeakGuardFromContext({
        oldPat: secrets.old_pat,
        managementReader: secrets.management_reader,
        oldService: secrets.old_service,
        replacementService: secrets.replacement_service,
      }),
    });
    validatePrecheck(precheck, { policy, publicKeyBytes: context.publicKeyBytes, claim, nowMs: issuedMs });
    atomicRootWrite(policy.state.precheck_path, canonicalCredentialJsonBytes(precheck), {
      mode: 0o600,
      exclusive: previousState === null && !pathExists(policy.state.precheck_path),
    });
  }
  const precheckSha = sha256(canonicalCredentialJsonBytes(precheck));
  writeLiveState(policy, liveStateRecord({
    state: "PREPARED",
    claim,
    claimSha256: claimSha,
    precheckSha256: precheckSha,
    previous: previousState,
    nowMs: now(),
  }));
  return { transactionId: claim.transaction_id, precheckSha256: precheckSha, runAttempt };
}

export function expirePreparedCredentialAttestation({
  candidateSha,
  runId,
  runAttempt,
  preCutoverInvocationId,
  now = Date.now,
}) {
  requireExpectedLiveArguments({ candidateSha, runId, runAttempt, invocationId: preCutoverInvocationId });
  const context = readInstalledCredentialContext();
  const { policy } = context;
  readInstalledProtection(candidateSha);
  if (installedServiceInvocationId() !== preCutoverInvocationId) refuse("service_invocation_changed");
  const nowMs = now();
  const state = readLiveState(policy);
  if (
    state === null || !["PREPARED", "EXPIRED"].includes(state.state) ||
    state.candidate_sha !== candidateSha || state.ci_run_id !== String(runId) ||
    state.ci_run_attempt !== runAttempt
  ) refuse("credential_live_state_identity_mismatch");
  for (const forbidden of [
    policy.state.revocation_proof_path,
    policy.state.completion_path,
    policy.state.live_readback_path,
    policy.state.consumed_path,
  ]) {
    if (pathExists(forbidden)) refuse("credential_prepared_expiry_state_conflict");
  }
  if (!preparedExpiryCleanupPending(policy)) {
    if (state.state !== "EXPIRED") refuse("credential_prepared_expiry_state_invalid");
    return { transactionId: state.transaction_id };
  }
  if (!pathExists(policy.state.escrow_directory)) refuse("credential_prepared_expiry_escrow_missing");
  const escrow = readCredentialEscrowForPreparedExpiry({
    policy,
    fingerprintKey: context.fingerprintKey,
    transactionId: state.transaction_id,
    nonce: state.nonce,
    claimSha256: state.claim_sha256,
    nowMs,
  });
  const claim = parseJsonBytes(escrow.claimBytes, "claim_json_invalid");
  const claimSha = sha256(canonicalCredentialJsonBytes(claim));
  if (
    claimSha !== state.claim_sha256 || claim.transaction_id !== state.transaction_id ||
    claim.nonce !== state.nonce || claim.candidate_sha !== candidateSha ||
    claim.ci_run_id !== String(runId) || claim.ci_run_attempt !== runAttempt
  ) refuse("credential_live_state_identity_mismatch");
  const claimExpiresMs = timestampMs(claim.expires_at, "claim_expired");
  if (claimExpiresMs > nowMs) refuse("credential_prepared_attestation_not_expired");
  const runtimeBytes = readTrustedRootFile(RUNTIME_ENV_PATH, {
    maximum: 262_144,
    modes: [0o600],
    label: "runtime",
  });
  if (!parseRuntimeServiceKey(runtimeBytes).equals(escrow.oldService)) {
    refuse("prepared_runtime_identity_mismatch");
  }
  const secrets = {
    old_pat: escrow.oldPat,
    management_reader: context.managementReader,
    old_service: escrow.oldService,
    replacement_service: escrow.replacementService,
  };
  distinctCredentialBytes(secrets);
  requireCredentialSetMatchesClaim({ policy, fingerprintKey: context.fingerprintKey, claim, secrets });
  let precheck = null;
  if (pathExists(policy.state.precheck_path) || pathExists(`${policy.state.precheck_path}.credential-consume`)) {
    const precheckPath = pathExists(policy.state.precheck_path)
      ? policy.state.precheck_path
      : `${policy.state.precheck_path}.credential-consume`;
    precheck = parseJsonBytes(readTrustedRootFile(precheckPath, {
      maximum: 2 * 1024 * 1024,
      modes: [0o600],
      label: "credential_precheck",
    }), "credential_precheck_invalid");
    if (sha256(canonicalCredentialJsonBytes(precheck)) !== state.precheck_sha256) {
      refuse("credential_live_state_identity_mismatch");
    }
    validatePrecheck(precheck, {
      policy,
      publicKeyBytes: context.publicKeyBytes,
      claim,
      nowMs: timestampMs(precheck.receipt?.signed_at, "precheck_expired"),
    });
  } else if (state.state === "PREPARED") {
    refuse("credential_prepared_expiry_precheck_missing");
  }
  if (state.state === "PREPARED") {
    writeLiveState(policy, liveStateRecord({
      state: transitionCredentialLiveState("PREPARED", "expire"),
      claim,
      claimSha256: claimSha,
      precheckSha256: state.precheck_sha256,
      previous: state,
      nowMs,
    }));
  }
  removeTrustedRootFileMatching(policy.inputs.claim_path, {
    maximum: 65_536,
    modes: [0o400, 0o600],
    label: "credential_expiry_claim",
    matches: (bytes) => bytes.equals(canonicalCredentialJsonBytes(claim)),
  });
  removeTrustedRootFileMatching(policy.inputs.provider_identity_receipt_path, {
    maximum: 262_144,
    modes: [0o400, 0o600],
    label: "credential_expiry_provider_identity_receipt",
    matches: (bytes) => bytes.equals(escrow.providerIdentityReceiptBytes),
  });
  removeTrustedRootFileMatching(policy.inputs.old_pat_path, {
    maximum: 4096,
    modes: [0o400, 0o600],
    label: "credential_expiry_old_pat",
    matches: (bytes) => parseSingleLineSecret(bytes, "old_pat_invalid").equals(escrow.oldPat),
  });
  removeTrustedRootFileMatching(policy.inputs.replacement_service_path, {
    maximum: 4096,
    modes: [0o400, 0o600],
    label: "credential_expiry_replacement_service",
    matches: (bytes) => parseRuntimeServiceKey(bytes).equals(escrow.replacementService),
  });
  if (precheck !== null) {
    removeTrustedRootFileMatching(policy.state.precheck_path, {
      maximum: 2 * 1024 * 1024,
      modes: [0o600],
      label: "credential_expiry_precheck",
      matches: (bytes) => bytes.equals(canonicalCredentialJsonBytes(precheck)),
    });
  }
  deleteCredentialEscrow(policy);
  if (preparedExpiryCleanupPending(policy)) refuse("credential_prepared_expiry_cleanup_incomplete");
  return { transactionId: state.transaction_id };
}

function readAwaitingInstalledContext({ candidateSha, runId, runAttempt, postCutoverInvocationId, nowMs }) {
  requireExpectedLiveArguments({
    candidateSha,
    runId,
    runAttempt,
    invocationId: postCutoverInvocationId,
  });
  const context = readInstalledCredentialContext();
  const transitionLastStaging = "/var/lib/newme/deploy-state/credential-transition.last.next";
  if (pathExists(transitionLastStaging)) {
    readTrustedRootFile(transitionLastStaging, {
      maximum: 65_536,
      modes: [0o600],
      label: "credential_transition_last_staging",
    });
    unlinkSync(transitionLastStaging);
    fsyncDirectory(path.dirname(transitionLastStaging));
  }
  for (const conflict of [
    "/var/lib/newme/deploy-state/credential-transition.pending.next",
    "/var/lib/newme/deploy-state/credential-transition.previous.env.preparing",
    "/var/lib/newme/deploy-state/credential-remediation.protected.next",
    "/etc/newme/newme-runtime.env.credential-transition.next",
  ]) {
    if (pathExists(conflict)) refuse("credential_transition_staging_conflict");
  }
  const state = readLiveState(context.policy);
  if (state === null || state.candidate_sha !== candidateSha || state.ci_run_id !== String(runId) || state.ci_run_attempt !== runAttempt) {
    refuse("credential_live_state_identity_mismatch");
  }
  const escrow = readCredentialEscrow({
    policy: context.policy,
    fingerprintKey: context.fingerprintKey,
    transactionId: state.transaction_id,
    nonce: state.nonce,
    claimSha256: state.claim_sha256,
    nowMs,
  });
  const claim = parseJsonBytes(escrow.claimBytes, "claim_json_invalid");
  const providerIdentityReceipt = parseJsonBytes(
    escrow.providerIdentityReceiptBytes,
    "provider_identity_receipt_invalid",
  );
  validateProviderIdentityReceipt(providerIdentityReceipt, {
    policy: context.policy,
    publicKeyBytes: context.publicKeyBytes,
    claim,
    nowMs,
  });
  const precheck = readEvidenceFile(context.policy.state.precheck_path, "credential_precheck");
  requireStateIdentity(state, claim, state.claim_sha256, state.precheck_sha256, [
    "PREPARED", "CUTOVER_INFLIGHT", "COMPLETE", "CONSUMED",
  ]);
  if (
    state.claim_sha256 !== sha256(canonicalCredentialJsonBytes(claim)) ||
    state.precheck_sha256 !== sha256(canonicalCredentialJsonBytes(precheck))
  ) refuse("credential_live_state_identity_mismatch");
  const transitionLastRecordBytes = readTrustedRootFile(TRANSITION_LAST_PATH, {
    maximum: 65_536,
    modes: [0o600],
    label: "credential_transition_last",
  });
  const parsedTransitionLast = parseTransitionLastRecord(transitionLastRecordBytes);
  const transitionLastBytes = parsedTransitionLast.evidenceBytes;
  const transition = parsedTransitionLast.transition;
  const finalizedTransition = parsedTransitionLast.completeRecord;
  const transitionFinishedMs = timestampMs(transition.finished_at, "completion_transition_invalid");
  validatePrecheck(precheck, {
    policy: context.policy,
    publicKeyBytes: context.publicKeyBytes,
    claim,
    providerIdentityReceipt,
    nowMs: transitionFinishedMs,
  });
  if (
    transition.transaction_id !== claim.transaction_id || transition.candidate_sha !== candidateSha ||
    transition.ci_run_id !== String(runId) || transition.ci_run_attempt !== runAttempt ||
    transition.precheck_sha256 !== state.precheck_sha256 ||
    transition.before_sha256 !== precheck.transition_before_sha256
  ) refuse("completion_transition_invalid");
  let pending = null;
  if (pathExists(TRANSITION_PENDING_PATH)) {
    pending = readEvidenceFile(TRANSITION_PENDING_PATH, "credential_transition_pending", 65_536);
    exactKeys(pending, [
      "version", "phase", "protection_before", "transaction_id", "precheck_sha256", "candidate_sha",
      "ci_run_id", "ci_run_attempt", "started_at", "before_sha256", "after_sha256",
    ], "credential_transition_pending_invalid");
    if (
      pending.version !== 1 || pending.phase !== "awaiting_provider_revocation" ||
      pending.transaction_id !== transition.transaction_id || pending.precheck_sha256 !== transition.precheck_sha256 ||
      pending.candidate_sha !== transition.candidate_sha || pending.ci_run_id !== transition.ci_run_id ||
      pending.ci_run_attempt !== transition.ci_run_attempt || pending.before_sha256 !== transition.before_sha256 ||
      pending.after_sha256 !== transition.after_sha256
    ) refuse("credential_transition_pending_invalid");
  } else if (finalizedTransition === null) {
    refuse("credential_transition_pending_invalid");
  }
  if (finalizedTransition !== null && (
    !["COMPLETE", "CONSUMED"].includes(state.state) ||
    finalizedTransition.completion_sha256 !== state.completion_sha256
  )) refuse("credential_transition_completion_mismatch");
  let backupBytes = null;
  if (pathExists(TRANSITION_BACKUP_PATH)) {
    backupBytes = readTrustedRootFile(TRANSITION_BACKUP_PATH, {
      maximum: 262_144,
      modes: [0o600],
      label: "credential_transition_backup",
    });
    if (sha256(backupBytes) !== transition.before_sha256) refuse("credential_transition_runtime_mismatch");
  } else if (finalizedTransition === null) {
    refuse("credential_transition_backup_missing");
  }
  const runtimeBytes = readTrustedRootFile(RUNTIME_ENV_PATH, {
    maximum: 262_144,
    modes: [0o600],
    label: "runtime",
  });
  if (sha256(runtimeBytes) !== transition.after_sha256) {
    refuse("credential_transition_runtime_mismatch");
  }
  const secrets = {
    old_pat: escrow.oldPat,
    management_reader: context.managementReader,
    old_service: escrow.oldService,
    replacement_service: escrow.replacementService,
  };
  if (!parseRuntimeServiceKey(runtimeBytes).equals(secrets.replacement_service)) {
    refuse("credential_transition_runtime_mismatch");
  }
  if (!pathExists(context.policy.inputs.replacement_service_path) && finalizedTransition === null) {
    atomicRootWrite(
      context.policy.inputs.replacement_service_path,
      Buffer.from(`SUPABASE_SERVICE_ROLE_KEY=${secrets.replacement_service.toString("utf8")}\n`, "utf8"),
      { mode: 0o600, exclusive: true },
    );
  }
  if (pathExists(context.policy.inputs.replacement_service_path)) {
    const inboxReplacement = parseRuntimeServiceKey(readTrustedRootFile(context.policy.inputs.replacement_service_path, {
      maximum: 4096,
      modes: [0o400, 0o600],
      label: "replacement_service",
    }));
    if (!inboxReplacement.equals(secrets.replacement_service)) refuse("credential_inbox_candidate_mismatch");
  }
  requireCredentialSetMatchesClaim({
    policy: context.policy,
    fingerprintKey: context.fingerprintKey,
    claim,
    secrets,
  });
  const protection = readInstalledProtection(candidateSha);
  if (protection.sha256 !== precheck.protected_assets_sha256) refuse("protected_assets_changed");
  const actualInvocationId = installedServiceInvocationId();
  if (
    actualInvocationId !== postCutoverInvocationId ||
    postCutoverInvocationId === precheck.pre_cutover_invocation_id
  ) refuse("service_invocation_changed");
  return {
    ...context,
    state,
    escrow,
    claim,
    providerIdentityReceipt,
    precheck,
    transition,
    transitionLastBytes,
    transitionLastSha256: sha256(transitionLastBytes),
    finalizedTransition,
    transitionFinishedMs,
    protection,
    runtimeBytes,
    secrets,
    postCutoverInvocationId,
  };
}

function transitionProjection(live) {
  return {
    last_sha256: live.transitionLastSha256,
    status: live.transition.status,
    ci_run_id: live.transition.ci_run_id,
    ci_run_attempt: live.transition.ci_run_attempt,
    before_sha256: live.transition.before_sha256,
    after_sha256: live.transition.after_sha256,
  };
}

async function collectPostCutoverEvidence({
  live,
  fetchImpl,
  now,
  ciCandidateSha = live.claim.candidate_sha,
  ciRunId = live.claim.ci_run_id,
  ciRunAttempt = live.claim.ci_run_attempt,
}) {
  const { policy } = live;
  const ci = await collectCiEvidence({
    fetchImpl,
    policy,
    token: live.githubReader,
    candidateSha: ciCandidateSha,
    runId: ciRunId,
    runAttempt: ciRunAttempt,
    nowMs: now,
  });
  const supabase = await collectSupabaseEvidence({
    fetchImpl,
    policy,
    token: live.managementReader,
    credentials: live.claim.credentials,
    stage: "completion",
    nowMs: now,
    providerIdentityReceipt: live.providerIdentityReceipt,
    publicKeyBytes: live.publicKeyBytes,
    claim: live.claim,
  });
  const common = {
    fetchImpl,
    policy,
    fingerprintKey: live.fingerprintKey,
    transactionId: live.claim.transaction_id,
    nonce: live.claim.nonce,
    nowMs: now,
  };
  const sandwiches = {
    pat: await collectSandwich({
      ...common,
      kind: "pat",
      oldCredentialKind: "old_pat",
      replacementCredentialKind: "management_reader",
      oldCredential: live.secrets.old_pat,
      replacementCredential: live.secrets.management_reader,
      oldFingerprint: live.claim.credentials.old_pat.fingerprint,
      replacementFingerprint: live.claim.credentials.management_reader.fingerprint,
      oldProviderKind: "pat",
      replacementProviderKind: "pat",
    }),
    service: await collectSandwich({
      ...common,
      kind: "service",
      oldCredentialKind: "old_service",
      replacementCredentialKind: "replacement_service",
      oldCredential: live.secrets.old_service,
      replacementCredential: live.secrets.replacement_service,
      oldFingerprint: live.claim.credentials.old_service.fingerprint,
      replacementFingerprint: live.claim.credentials.replacement_service.fingerprint,
      oldProviderKind: policy.credential_identities.old_service.provider_kind,
      replacementProviderKind: policy.credential_identities.replacement_service.provider_kind,
    }),
  };
  const serviceProbe = await probeCredential({
    fetchImpl,
    policy,
    kind: "service",
    credentialKind: "replacement_service",
    token: live.secrets.replacement_service,
    fingerprint: live.claim.credentials.replacement_service.fingerprint,
    fingerprintKey: live.fingerprintKey,
    transactionId: live.claim.transaction_id,
    nonce: live.claim.nonce,
    providerKind: policy.credential_identities.replacement_service.provider_kind,
    nowMs: now,
  });
  if (serviceProbe.status !== 200 || serviceProbe.provider_code !== "success") {
    refuse("replacement_service_probe_refused");
  }
  const measureControlPlane = () => measureInstalledControlPlane(
    live.claim.candidate_sha,
    live.postCutoverInvocationId,
  );
  const measured = measureControlPlane();
  if (measured.protectedAssetsSha256 !== live.precheck.protected_assets_sha256) {
    refuse("protected_assets_changed");
  }
  const consumers = createConsumerEvidence({
    policy,
    transitionLastSha256: live.transitionLastSha256,
    invocationId: live.postCutoverInvocationId,
    replacementFingerprint: live.claim.credentials.replacement_service.fingerprint,
    protectedAssetsSha256: measured.protectedAssetsSha256,
    runCommand: defaultRunCommand,
    serviceProbe,
    measureControlPlane,
    nowMs: now,
  });
  return { ci, supabase, sandwiches, serviceProbe, consumers, protectedAssetsSha256: measured.protectedAssetsSha256 };
}

export async function produceInstalledRevocationProof({
  candidateSha,
  runId,
  runAttempt,
  postCutoverInvocationId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const currentMs = now();
  const live = readAwaitingInstalledContext({
    candidateSha,
    runId,
    runAttempt,
    postCutoverInvocationId,
    nowMs: currentMs,
  });
  requireStateIdentity(
    live.state,
    live.claim,
    sha256(canonicalCredentialJsonBytes(live.claim)),
    sha256(canonicalCredentialJsonBytes(live.precheck)),
    ["PREPARED", "CUTOVER_INFLIGHT"],
  );
  let proof;
  if (pathExists(live.policy.state.revocation_proof_path)) {
    proof = readEvidenceFile(live.policy.state.revocation_proof_path, "credential_revocation_proof");
    validateRevocationProof(proof, {
      policy: live.policy,
      publicKeyBytes: live.publicKeyBytes,
      claim: live.claim,
      precheck: live.precheck,
      transitionLastBytes: live.transitionLastBytes,
      nowMs: currentMs,
    });
  }
  const evidence = await collectPostCutoverEvidence({ live, fetchImpl, now });
  const github = await collectGithubEvidence({
    fetchImpl,
    policy: live.policy,
    token: live.githubSecretScanningReader,
    requiredState: "open",
    nowMs: now,
  });
  const finalControlPlane = measureInstalledControlPlane(candidateSha, postCutoverInvocationId);
  if (finalControlPlane.protectedAssetsSha256 !== evidence.protectedAssetsSha256) {
    refuse("consumer_control_plane_changed");
  }
  if (proof === undefined || proof.post_cutover_invocation_id !== postCutoverInvocationId) {
    const issuedMs = now();
    const expiresMs = Math.min(
      Date.parse(live.escrow.expiresAt),
      issuedMs + live.policy.escrow_ttl_seconds * 1000,
    );
    if (expiresMs <= issuedMs) refuse("escrow_expired");
    proof = signCredentialEvidence({
      document: {
        version: REVOCATION_PROOF_VERSION,
        purpose: "revocation_proof",
        transaction_id: live.claim.transaction_id,
        nonce: live.claim.nonce,
        policy_sha256: policySha256(live.policy),
        candidate_sha: live.claim.candidate_sha,
        ci: evidence.ci,
        precheck_sha256: sha256(canonicalCredentialJsonBytes(live.precheck)),
        transition: transitionProjection(live),
        credentials: live.claim.credentials,
        github,
        supabase: evidence.supabase,
        sandwiches: evidence.sandwiches,
        protected_assets_sha256: evidence.protectedAssetsSha256,
        pre_cutover_invocation_id: live.precheck.pre_cutover_invocation_id,
        post_cutover_invocation_id: live.postCutoverInvocationId,
        consumers: evidence.consumers,
        issued_at: isoAt(issuedMs),
        expires_at: isoAt(expiresMs),
      },
      privateKeyBytes: live.privateKeyBytes,
      publicKeyBytes: live.publicKeyBytes,
      signedAt: isoAt(issuedMs),
      secretLeakGuard: secretLeakGuardFromContext({
        oldPat: live.secrets.old_pat,
        managementReader: live.secrets.management_reader,
        oldService: live.secrets.old_service,
        replacementService: live.secrets.replacement_service,
      }),
    });
    validateRevocationProof(proof, {
      policy: live.policy,
      publicKeyBytes: live.publicKeyBytes,
      claim: live.claim,
      precheck: live.precheck,
      transitionLastBytes: live.transitionLastBytes,
      nowMs: issuedMs,
    });
    atomicRootWrite(live.policy.state.revocation_proof_path, canonicalCredentialJsonBytes(proof), {
      mode: 0o600,
      exclusive: false,
    });
  }
  const proofSha = sha256(canonicalCredentialJsonBytes(proof));
  if (live.state.revocation_proof_sha256 !== null && live.state.revocation_proof_sha256 !== proofSha) {
    refuse("credential_live_state_identity_mismatch");
  }
  writeLiveState(live.policy, liveStateRecord({
    state: "CUTOVER_INFLIGHT",
    claim: live.claim,
    claimSha256: sha256(canonicalCredentialJsonBytes(live.claim)),
    precheckSha256: sha256(canonicalCredentialJsonBytes(live.precheck)),
    previous: live.state,
    revocationProofSha256: proofSha,
    nowMs: now(),
  }));
  return { transactionId: live.claim.transaction_id, revocationProofSha256: proofSha };
}

export async function produceInstalledCompletion({
  candidateSha,
  runId,
  runAttempt,
  postCutoverInvocationId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const currentMs = now();
  const live = readAwaitingInstalledContext({
    candidateSha,
    runId,
    runAttempt,
    postCutoverInvocationId,
    nowMs: currentMs,
  });
  requireStateIdentity(
    live.state,
    live.claim,
    sha256(canonicalCredentialJsonBytes(live.claim)),
    sha256(canonicalCredentialJsonBytes(live.precheck)),
    ["CUTOVER_INFLIGHT", "COMPLETE"],
  );
  const proof = readEvidenceFile(live.policy.state.revocation_proof_path, "credential_revocation_proof");
  const proofResult = validateRevocationProof(proof, {
    policy: live.policy,
    publicKeyBytes: live.publicKeyBytes,
    claim: live.claim,
    precheck: live.precheck,
    transitionLastBytes: live.transitionLastBytes,
    nowMs: currentMs,
  });
  if (live.state.revocation_proof_sha256 !== proofResult.sha256) refuse("credential_live_state_identity_mismatch");
  let completion;
  if (pathExists(live.policy.state.completion_path)) {
    completion = readEvidenceFile(live.policy.state.completion_path, "credential_completion");
    validateCompletion(completion, {
      policy: live.policy,
      publicKeyBytes: live.publicKeyBytes,
      claim: live.claim,
      precheck: live.precheck,
      transitionLastBytes: live.transitionLastBytes,
      nowMs: currentMs,
    });
  }
  const evidence = await collectPostCutoverEvidence({ live, fetchImpl, now });
  const github = await collectGithubEvidence({
    fetchImpl,
    policy: live.policy,
    token: live.githubSecretScanningReader,
    requiredState: "resolved",
    nowMs: now,
  });
  const finalControlPlane = measureInstalledControlPlane(candidateSha, postCutoverInvocationId);
  if (finalControlPlane.protectedAssetsSha256 !== evidence.protectedAssetsSha256) {
    refuse("consumer_control_plane_changed");
  }
  if (completion === undefined || completion.post_cutover_invocation_id !== postCutoverInvocationId) {
    if (
      pathExists(live.policy.state.live_readback_path) ||
      pathExists(live.policy.state.consumed_path)
    ) refuse("completion_rebind_after_consumption_refused");
    const issuedMs = now();
    completion = signCredentialEvidence({
      document: {
        version: COMPLETION_VERSION,
        purpose: "completion",
        transaction_id: live.claim.transaction_id,
        nonce: live.claim.nonce,
        policy_sha256: policySha256(live.policy),
        candidate_sha: live.claim.candidate_sha,
        ci: evidence.ci,
        precheck_sha256: sha256(canonicalCredentialJsonBytes(live.precheck)),
        transition: transitionProjection(live),
        credentials: live.claim.credentials,
        github,
        supabase: evidence.supabase,
        sandwiches: evidence.sandwiches,
        protected_assets_sha256: evidence.protectedAssetsSha256,
        pre_cutover_invocation_id: live.precheck.pre_cutover_invocation_id,
        post_cutover_invocation_id: live.postCutoverInvocationId,
        consumers: evidence.consumers,
        revocation_proof: proof,
        issued_at: isoAt(issuedMs),
        expires_at: isoAt(issuedMs + live.policy.completion_max_age_seconds * 1000),
      },
      privateKeyBytes: live.privateKeyBytes,
      publicKeyBytes: live.publicKeyBytes,
      signedAt: isoAt(issuedMs),
      secretLeakGuard: secretLeakGuardFromContext({
        oldPat: live.secrets.old_pat,
        managementReader: live.secrets.management_reader,
        oldService: live.secrets.old_service,
        replacementService: live.secrets.replacement_service,
      }),
    });
    validateCompletion(completion, {
      policy: live.policy,
      publicKeyBytes: live.publicKeyBytes,
      claim: live.claim,
      precheck: live.precheck,
      transitionLastBytes: live.transitionLastBytes,
      nowMs: issuedMs,
    });
    atomicRootWrite(live.policy.state.completion_path, canonicalCredentialJsonBytes(completion), {
      mode: 0o600,
      exclusive: false,
    });
  }
  const completionSha = sha256(canonicalCredentialJsonBytes(completion));
  if (live.state.completion_sha256 !== null && live.state.completion_sha256 !== completionSha) {
    refuse("credential_live_state_identity_mismatch");
  }
  writeLiveState(live.policy, liveStateRecord({
    state: "COMPLETE",
    claim: live.claim,
    claimSha256: sha256(canonicalCredentialJsonBytes(live.claim)),
    precheckSha256: sha256(canonicalCredentialJsonBytes(live.precheck)),
    previous: live.state,
    revocationProofSha256: proofResult.sha256,
    completionSha256: completionSha,
    nowMs: now(),
  }));
  return { transactionId: live.claim.transaction_id, completionSha256: completionSha };
}

function canonicalGit(args) {
  requireTrustedRootDirectory(CANONICAL_RELEASE_MIRROR, {
    modes: [0o700, 0o750, 0o755],
    label: "canonical_release_mirror",
  });
  const result = spawnSync("/usr/bin/git", [`--git-dir=${CANONICAL_RELEASE_MIRROR}`, ...args], {
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    refuse("release_relation_measurement_failed");
  }
  return result.stdout.trim();
}

export function measureInstalledReleaseRelation({ remediationSha, releaseSha }) {
  if (!SHA40.test(remediationSha) || !SHA40.test(releaseSha)) refuse("release_relation_identity_invalid");
  const directParent = canonicalGit(["rev-parse", `${releaseSha}^`]);
  const commitCount = Number(canonicalGit(["rev-list", "--count", `${remediationSha}..${releaseSha}`]));
  const paths = (value) => value === "" ? [] : value.split("\n").filter(Boolean);
  return {
    remediation_sha: remediationSha,
    release_sha: releaseSha,
    commit_count: commitCount,
    direct_parent: directParent,
    changed_paths: paths(canonicalGit(["diff", "--name-only", "--no-renames", remediationSha, releaseSha, "--"])),
    per_commit_changed_paths: [paths(canonicalGit([
      "diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", releaseSha, "--",
    ]))],
  };
}

export async function produceInstalledReadback({
  remediationSha,
  releaseSha,
  runId,
  runAttempt,
  postCutoverInvocationId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  requireExpectedLiveArguments({
    candidateSha: releaseSha,
    runId,
    runAttempt,
    invocationId: postCutoverInvocationId,
  });
  if (!SHA40.test(remediationSha)) refuse("live_command_identity_invalid");
  const initialContext = readInstalledCredentialContext();
  const initialState = readLiveState(initialContext.policy);
  if (initialState === null || initialState.candidate_sha !== remediationSha || initialState.state !== "COMPLETE") {
    refuse("credential_live_state_identity_mismatch");
  }
  const live = readAwaitingInstalledContext({
    candidateSha: remediationSha,
    runId: initialState.ci_run_id,
    runAttempt: initialState.ci_run_attempt,
    postCutoverInvocationId,
    nowMs: now(),
  });
  const completion = readEvidenceFile(live.policy.state.completion_path, "credential_completion");
  const completionResult = validateCompletion(completion, {
    policy: live.policy,
    publicKeyBytes: live.publicKeyBytes,
    claim: live.claim,
    precheck: live.precheck,
    transitionLastBytes: live.transitionLastBytes,
    nowMs: now(),
  });
  if (initialState.completion_sha256 !== completionResult.sha256) refuse("credential_live_state_identity_mismatch");
  let previous = null;
  if (pathExists(live.policy.state.live_readback_path)) {
    previous = readEvidenceFile(live.policy.state.live_readback_path, "credential_live_readback");
    const historicalNow = timestampMs(previous.receipt?.signed_at, "readback_expired");
    validateReadback(previous, {
      policy: live.policy,
      publicKeyBytes: live.publicKeyBytes,
      completion,
      transitionLastBytes: live.transitionLastBytes,
      expectedRun: previous.ci?.run_id,
      expectedAttempt: previous.ci?.run_attempt,
      measureReleaseRelation: measureInstalledReleaseRelation,
      nowMs: historicalNow,
    });
    if (previous.remediation_sha !== remediationSha || previous.release_sha !== releaseSha) {
      refuse("readback_release_reuse_refused");
    }
  }
  let pendingTombstone = null;
  if (pathExists(live.policy.state.consumed_path)) {
    if (previous === null) refuse("tombstone_readback_missing");
    pendingTombstone = readEvidenceFile(live.policy.state.consumed_path, "credential_consumed_tombstone");
    validateTombstone(pendingTombstone, {
      policy: live.policy,
      publicKeyBytes: live.publicKeyBytes,
      completion,
      precheck: live.precheck,
      claim: live.claim,
      transitionLastBytes: live.transitionLastBytes,
      readback: previous,
      expectedReleaseSha: releaseSha,
      expectedRun: String(runId),
      expectedAttempt: runAttempt,
      measureReleaseRelation: measureInstalledReleaseRelation,
      nowMs: timestampMs(pendingTombstone.consumed_at, "tombstone_timestamp_invalid"),
    });
  }
  const evidence = await collectPostCutoverEvidence({
    live,
    fetchImpl,
    now,
    ciCandidateSha: releaseSha,
    ciRunId: String(runId),
    ciRunAttempt: runAttempt,
  });
  const github = await collectGithubEvidence({
    fetchImpl,
    policy: live.policy,
    token: live.githubSecretScanningReader,
    requiredState: "resolved",
    nowMs: now,
  });
  const finalControlPlane = measureInstalledControlPlane(remediationSha, postCutoverInvocationId);
  if (finalControlPlane.protectedAssetsSha256 !== evidence.protectedAssetsSha256) {
    refuse("consumer_control_plane_changed");
  }
  const relation = measureInstalledReleaseRelation({ remediationSha, releaseSha });
  validateReleaseRelation(relation, {
    remediationSha,
    releaseSha,
    measureRelation: measureInstalledReleaseRelation,
  });
  const observedMs = now();
  const readback = signCredentialEvidence({
    document: {
      version: READBACK_VERSION,
      purpose: "readback",
      transaction_id: live.claim.transaction_id,
      nonce: live.claim.nonce,
      policy_sha256: policySha256(live.policy),
      completion_sha256: completionResult.sha256,
      remediation_sha: remediationSha,
      release_sha: releaseSha,
      ci: evidence.ci,
      claim: live.claim,
      precheck: live.precheck,
      github,
      supabase: evidence.supabase,
      sandwiches: evidence.sandwiches,
      protected_assets_sha256: evidence.protectedAssetsSha256,
      post_cutover_invocation_id: postCutoverInvocationId,
      service_probe: evidence.serviceProbe,
      consumers: evidence.consumers,
      relation,
      observed_at: isoAt(observedMs),
      expires_at: isoAt(observedMs + live.policy.live_readback_ttl_seconds * 1000),
    },
    privateKeyBytes: live.privateKeyBytes,
    publicKeyBytes: live.publicKeyBytes,
    signedAt: isoAt(observedMs),
    secretLeakGuard: secretLeakGuardFromContext({
      oldPat: live.secrets.old_pat,
      managementReader: live.secrets.management_reader,
      oldService: live.secrets.old_service,
      replacementService: live.secrets.replacement_service,
    }),
  });
  const readbackResult = validateReadback(readback, {
    policy: live.policy,
    publicKeyBytes: live.publicKeyBytes,
    completion,
    transitionLastBytes: live.transitionLastBytes,
    expectedRun: String(runId),
    expectedAttempt: runAttempt,
    measureReleaseRelation: measureInstalledReleaseRelation,
    nowMs: observedMs,
  });
  if (pendingTombstone === null) {
    atomicRootWrite(live.policy.state.live_readback_path, canonicalCredentialJsonBytes(readback), { mode: 0o600 });
  }
  const durableReadbackSha256 = pendingTombstone === null
    ? readbackResult.sha256
    : sha256(canonicalCredentialJsonBytes(previous));
  const durableTombstoneSha256 = pendingTombstone === null
    ? live.state.tombstone_sha256
    : sha256(canonicalCredentialJsonBytes(pendingTombstone));
  writeLiveState(live.policy, liveStateRecord({
    state: "COMPLETE",
    claim: live.claim,
    claimSha256: sha256(canonicalCredentialJsonBytes(live.claim)),
    precheckSha256: sha256(canonicalCredentialJsonBytes(live.precheck)),
    previous: live.state,
    revocationProofSha256: live.state.revocation_proof_sha256,
    completionSha256: completionResult.sha256,
    readbackSha256: durableReadbackSha256,
    tombstoneSha256: durableTombstoneSha256,
    releaseSha,
    nowMs: now(),
  }));
  return { transactionId: live.claim.transaction_id, readbackSha256: durableReadbackSha256 };
}

export function removeTrustedRootFileMatching(file, {
  maximum,
  modes,
  label,
  matches,
}) {
  const quarantine = `${file}.credential-consume`;
  const sourceExists = pathExists(file);
  const quarantineExists = pathExists(quarantine);
  if (sourceExists && quarantineExists) refuse(`${label}_consume_conflict`);
  if (!sourceExists && !quarantineExists) return false;

  if (sourceExists) {
    requireTrustedRootAncestors(file, label);
    try {
      renameSync(file, quarantine);
      fsyncDirectory(path.dirname(file));
    } catch {
      refuse(`${label}_consume_failed`);
    }
  }

  try {
    const bytes = readTrustedRootFile(quarantine, {
      maximum,
      modes,
      label: `${label}_quarantine`,
    });
    if (!matches(bytes)) refuse(`${label}_mismatch`);
  } catch (error) {
    if (!pathExists(file) && pathExists(quarantine)) {
      try {
        renameSync(quarantine, file);
        fsyncDirectory(path.dirname(file));
      } catch {
        refuse(`${label}_restore_failed`);
      }
    }
    throw error;
  }

  unlinkSync(quarantine);
  fsyncDirectory(path.dirname(file));
  return true;
}

function credentialCleanupPending(policy) {
  return [
    policy.inputs.claim_path,
    `${policy.inputs.claim_path}.credential-consume`,
    policy.inputs.provider_identity_receipt_path,
    `${policy.inputs.provider_identity_receipt_path}.credential-consume`,
    policy.inputs.old_pat_path,
    `${policy.inputs.old_pat_path}.credential-consume`,
  ].some(pathExists) || pathExists(policy.state.escrow_directory);
}

function invokeTransitionLiveFinalizer({ completion, transitionLastBytes }) {
  const transition = parseTransitionLast(transitionLastBytes);
  const completionSha256 = sha256(canonicalCredentialJsonBytes(completion));
  const stdio = Array(10).fill("ignore");
  stdio[1] = "pipe";
  stdio[9] = 9;
  const result = spawnSync("/usr/bin/node", [
    TRANSITION_HELPER_PATH,
    "finalize-live",
    completion.candidate_sha,
    completion.ci.run_id,
    String(completion.ci.run_attempt),
    completion.transaction_id,
    completion.precheck_sha256,
    transition.before_sha256,
    transition.after_sha256,
    completion.transition.last_sha256,
    completionSha256,
  ], {
    env: { HOME: "/root", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    stdio,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stdout !== "credential_transition=complete\n") {
    refuse("credential_transition_live_finalize_failed");
  }
  const finalizedBytes = readTrustedRootFile(TRANSITION_LAST_PATH, {
    maximum: 65_536,
    modes: [0o600],
    label: "credential_transition_last",
  });
  const finalized = parseTransitionLastRecord(finalizedBytes);
  if (
    finalized.completeRecord === null ||
    finalized.completeRecord.completion_sha256 !== completionSha256 ||
    finalized.completeRecord.awaiting_last_sha256 !== completion.transition.last_sha256 ||
    !finalized.evidenceBytes.equals(Buffer.from(transitionLastBytes)) ||
    pathExists(TRANSITION_PENDING_PATH) ||
    pathExists(TRANSITION_BACKUP_PATH)
  ) refuse("credential_transition_live_finalize_failed");
  return finalized.evidenceBytes;
}

function cleanupConsumedCredentialMaterial(context, escrow) {
  const { policy } = context;
  removeTrustedRootFileMatching(policy.inputs.claim_path, {
    maximum: 65_536,
    modes: [0o400, 0o600],
    label: "credential_cleanup_claim",
    matches: (bytes) => bytes.equals(escrow.claimBytes),
  });
  removeTrustedRootFileMatching(policy.inputs.old_pat_path, {
    maximum: 4096,
    modes: [0o400, 0o600],
    label: "credential_cleanup_old_pat",
    matches: (bytes) => parseSingleLineSecret(bytes, "old_pat_invalid").equals(escrow.oldPat),
  });
  removeTrustedRootFileMatching(policy.inputs.provider_identity_receipt_path, {
    maximum: 262_144,
    modes: [0o400, 0o600],
    label: "credential_cleanup_provider_identity_receipt",
    matches: (bytes) => bytes.equals(escrow.providerIdentityReceiptBytes),
  });
  deleteCredentialEscrow(policy);
}

async function resumeConsumedCredentialCleanup({
  state,
  context,
  releaseSha,
  runId,
  runAttempt,
  postCutoverInvocationId,
  fetchImpl,
  now,
}) {
  if (
    state.state !== "CONSUMED" || state.release_sha !== releaseSha ||
    !SAFE_ID.test(postCutoverInvocationId)
  ) refuse("credential_consumed_state_invalid");
  const completion = readEvidenceFile(context.policy.state.completion_path, "credential_completion");
  const readback = readEvidenceFile(context.policy.state.live_readback_path, "credential_live_readback");
  const tombstone = readEvidenceFile(context.policy.state.consumed_path, "credential_consumed_tombstone");
  const transitionLastRecordBytes = readTrustedRootFile(TRANSITION_LAST_PATH, {
    maximum: 65_536,
    modes: [0o600],
    label: "credential_transition_last",
  });
  const parsedTransitionLast = parseTransitionLastRecord(transitionLastRecordBytes);
  if (parsedTransitionLast.completeRecord === null) refuse("credential_transition_live_finalize_incomplete");
  const transitionLastBytes = parsedTransitionLast.evidenceBytes;
  validateTombstone(tombstone, {
    policy: context.policy,
    publicKeyBytes: context.publicKeyBytes,
    completion,
    precheck: readback.precheck,
    claim: readback.claim,
    transitionLastBytes,
    readback,
    expectedReleaseSha: releaseSha,
    expectedRun: String(runId),
    expectedAttempt: runAttempt,
    measureReleaseRelation: measureInstalledReleaseRelation,
    nowMs: now(),
  });
  if (
    state.tombstone_sha256 !== sha256(canonicalCredentialJsonBytes(tombstone)) ||
    state.readback_sha256 !== sha256(canonicalCredentialJsonBytes(readback))
  ) refuse("credential_consumed_state_invalid");
  measureInstalledControlPlane(state.candidate_sha, postCutoverInvocationId);
  invokeTransitionLiveFinalizer({ completion, transitionLastBytes });
  if (!credentialCleanupPending(context.policy)) {
    return { transactionId: state.transaction_id, tombstoneSha256: state.tombstone_sha256 };
  }
  if (!pathExists(context.policy.state.escrow_directory)) refuse("credential_escrow_missing");
  requireTrustedRootDirectory(context.policy.state.escrow_directory, {
    modes: [0o700],
    label: "escrow_directory",
  });
  if (readdirSync(context.policy.state.escrow_directory).length === 0) {
    if (pathExists(context.policy.inputs.claim_path) || pathExists(context.policy.inputs.old_pat_path)) {
      refuse("credential_escrow_missing");
    }
    deleteCredentialEscrow(context.policy);
    return { transactionId: state.transaction_id, tombstoneSha256: state.tombstone_sha256 };
  }
  const live = readAwaitingInstalledContext({
    candidateSha: state.candidate_sha,
    runId: state.ci_run_id,
    runAttempt: state.ci_run_attempt,
    postCutoverInvocationId,
    nowMs: timestampMs(tombstone.consumed_at, "tombstone_timestamp_invalid"),
  });
  const evidence = await collectPostCutoverEvidence({
    live,
    fetchImpl,
    now,
    ciCandidateSha: releaseSha,
    ciRunId: String(runId),
    ciRunAttempt: runAttempt,
  });
  await collectGithubEvidence({
    fetchImpl,
    policy: context.policy,
    token: context.githubSecretScanningReader,
    requiredState: "resolved",
    nowMs: now,
  });
  const finalControlPlane = measureInstalledControlPlane(state.candidate_sha, postCutoverInvocationId);
  if (finalControlPlane.protectedAssetsSha256 !== evidence.protectedAssetsSha256) {
    refuse("consumer_control_plane_changed");
  }
  const relation = measureInstalledReleaseRelation({ remediationSha: state.candidate_sha, releaseSha });
  validateReleaseRelation(relation, {
    remediationSha: state.candidate_sha,
    releaseSha,
    measureRelation: measureInstalledReleaseRelation,
  });
  cleanupConsumedCredentialMaterial(context, live.escrow);
  return { transactionId: state.transaction_id, tombstoneSha256: state.tombstone_sha256 };
}

export async function consumeInstalledCredentialAttestation({
  remediationSha,
  releaseSha,
  runId,
  runAttempt,
  postCutoverInvocationId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  requireExpectedLiveArguments({
    candidateSha: releaseSha,
    runId,
    runAttempt,
    invocationId: postCutoverInvocationId,
  });
  if (!SHA40.test(remediationSha)) refuse("live_command_identity_invalid");
  let context = readInstalledCredentialContext();
  let state = readLiveState(context.policy);
  if (state === null || state.candidate_sha !== remediationSha) refuse("credential_live_state_identity_mismatch");
  if (state.state === "CONSUMED") {
    return await resumeConsumedCredentialCleanup({
      state,
      context,
      releaseSha,
      runId,
      runAttempt,
      postCutoverInvocationId,
      fetchImpl,
      now,
    });
  }
  if (state.state === "COMPLETE") {
    await produceInstalledReadback({
      remediationSha,
      releaseSha,
      runId,
      runAttempt,
      postCutoverInvocationId,
      fetchImpl,
      now,
    });
    context = readInstalledCredentialContext();
    state = readLiveState(context.policy);
  }
  if (state.state !== "COMPLETE" || state.release_sha !== releaseSha || state.readback_sha256 === null) {
    refuse("credential_live_state_identity_mismatch");
  }
  const nowMs = now();
  const live = readAwaitingInstalledContext({
    candidateSha: remediationSha,
    runId: state.ci_run_id,
    runAttempt: state.ci_run_attempt,
    postCutoverInvocationId,
    nowMs,
  });
  const completion = readEvidenceFile(context.policy.state.completion_path, "credential_completion");
  const readback = readEvidenceFile(context.policy.state.live_readback_path, "credential_live_readback");
  let tombstone;
  let readbackResult;
  if (pathExists(context.policy.state.consumed_path)) {
    tombstone = readEvidenceFile(context.policy.state.consumed_path, "credential_consumed_tombstone");
    const tombstoneResult = validateTombstone(tombstone, {
      policy: context.policy,
      publicKeyBytes: context.publicKeyBytes,
      completion,
      precheck: live.precheck,
      claim: live.claim,
      transitionLastBytes: live.transitionLastBytes,
      readback,
      expectedReleaseSha: releaseSha,
      expectedRun: String(runId),
      expectedAttempt: runAttempt,
      measureReleaseRelation: measureInstalledReleaseRelation,
      nowMs: timestampMs(tombstone.consumed_at, "tombstone_timestamp_invalid"),
    });
    const stateUpdatedMs = timestampMs(state.updated_at, "credential_live_state_invalid");
    const consumedMs = timestampMs(tombstone.consumed_at, "tombstone_timestamp_invalid");
    if (
      state.tombstone_sha256 !== tombstoneResult.sha256 ||
      state.readback_sha256 !== tombstone.readback_sha256 ||
      stateUpdatedMs < consumedMs || stateUpdatedMs > nowMs + 60_000 || nowMs - stateUpdatedMs > 120_000
    ) refuse("credential_consume_fresh_recheck_required");
    readbackResult = { sha256: tombstone.readback_sha256 };
  } else {
    readbackResult = validateReadback(readback, {
      policy: context.policy,
      publicKeyBytes: context.publicKeyBytes,
      completion,
      transitionLastBytes: live.transitionLastBytes,
      expectedRun: String(runId),
      expectedAttempt: runAttempt,
      measureReleaseRelation: measureInstalledReleaseRelation,
      nowMs,
    });
    if (readbackResult.sha256 !== state.readback_sha256 || state.tombstone_sha256 !== null) {
      refuse("credential_live_state_identity_mismatch");
    }
  }
  measureInstalledControlPlane(remediationSha, postCutoverInvocationId);
  if (tombstone === undefined) {
    tombstone = signCredentialEvidence({
      document: {
        version: TOMBSTONE_VERSION,
        purpose: "tombstone",
        state: "consumed",
        transaction_id: completion.transaction_id,
        nonce: completion.nonce,
        candidate_sha: remediationSha,
        release_sha: releaseSha,
        ci_run_id: String(runId),
        ci_run_attempt: runAttempt,
        transition_last_sha256: completion.transition.last_sha256,
        completion_sha256: sha256(canonicalCredentialJsonBytes(completion)),
        readback_sha256: readbackResult.sha256,
        consumed_at: isoAt(nowMs),
      },
      privateKeyBytes: context.privateKeyBytes,
      publicKeyBytes: context.publicKeyBytes,
      signedAt: isoAt(nowMs),
      secretLeakGuard: secretLeakGuardFromContext({
        oldPat: live.secrets.old_pat,
        managementReader: live.secrets.management_reader,
        oldService: live.secrets.old_service,
        replacementService: live.secrets.replacement_service,
      }),
    });
    atomicRootWrite(context.policy.state.consumed_path, canonicalCredentialJsonBytes(tombstone), {
      mode: 0o600,
      exclusive: true,
    });
  }
  const tombstoneResult = validateTombstone(tombstone, {
    policy: context.policy,
    publicKeyBytes: context.publicKeyBytes,
    completion,
    precheck: live.precheck,
    claim: live.claim,
    transitionLastBytes: live.transitionLastBytes,
    readback,
    expectedReleaseSha: releaseSha,
    expectedRun: String(runId),
    expectedAttempt: runAttempt,
    measureReleaseRelation: measureInstalledReleaseRelation,
    nowMs,
  });
  const transitionEvidenceBytes = invokeTransitionLiveFinalizer({
    completion,
    transitionLastBytes: live.transitionLastBytes,
  });
  validateTombstone(tombstone, {
    policy: context.policy,
    publicKeyBytes: context.publicKeyBytes,
    completion,
    precheck: live.precheck,
    claim: live.claim,
    transitionLastBytes: transitionEvidenceBytes,
    readback,
    expectedReleaseSha: releaseSha,
    expectedRun: String(runId),
    expectedAttempt: runAttempt,
    measureReleaseRelation: measureInstalledReleaseRelation,
    nowMs,
  });
  writeLiveState(context.policy, liveStateRecord({
    state: "CONSUMED",
    claim: live.claim,
    claimSha256: sha256(canonicalCredentialJsonBytes(live.claim)),
    precheckSha256: sha256(canonicalCredentialJsonBytes(live.precheck)),
    previous: state,
    revocationProofSha256: state.revocation_proof_sha256,
    completionSha256: state.completion_sha256,
    readbackSha256: readbackResult.sha256,
    tombstoneSha256: tombstoneResult.sha256,
    releaseSha,
    nowMs,
  }));
  cleanupConsumedCredentialMaterial(context, live.escrow);
  return { transactionId: live.claim.transaction_id, tombstoneSha256: tombstoneResult.sha256 };
}

export function inspectInstalledReceiptKey() {
  if (path.resolve(fileURLToPath(import.meta.url)) !== INSTALLED_HELPER_PATH) {
    refuse("installed_helper_path_invalid");
  }
  const publicKeyBytes = readTrustedRootFile("/etc/newme/postdeploy-acceptance-receipt.pub", {
    maximum: 16_384,
    modes: [0o400, 0o600, 0o640, 0o644],
    label: "receipt_public_key",
  });
  const digests = publicKeyDigests(publicKeyBytes);
  return { rawFileSha256: digests.file, spkiSha256: digests.spki };
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "check-policy") {
    const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const policy = JSON.parse(readFileSync(path.join(repositoryRoot, POLICY_PATH), "utf8"));
    validateCredentialLivePolicy(policy);
    process.stdout.write(`credential_live_policy_sha256=${policySha256(policy)}\n`);
    return 0;
  }
  if (argv.length === 5 && argv[0] === "verify-precheck") {
    const runAttempt = Number(argv[3]);
    const result = verifyInstalledPrecheck({
      candidateSha: argv[1],
      runId: argv[2],
      runAttempt,
      serviceInvocationId: argv[4],
    });
    process.stdout.write([
      `transaction_id=${result.transactionId}`,
      `precheck_sha256=${result.precheckSha256}`,
      `ci_run_attempt=${result.runAttempt}`,
      `protected_assets_sha256=${result.protectedAssetsSha256}`,
      `transition_before_sha256=${result.transitionBeforeSha256}`,
      `transition_after_sha256=${result.transitionAfterSha256}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 1 && argv[0] === "inspect-receipt-key") {
    const result = inspectInstalledReceiptKey();
    process.stdout.write([
      `receipt_public_key_file_sha256=${result.rawFileSha256}`,
      `receipt_public_key_spki_sha256=${result.spkiSha256}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 5 && argv[0] === "materialize-provider") {
    const result = await materializeInstalledProviderIdentity({
      candidateSha: argv[1],
      runId: argv[2],
      runAttempt: Number(argv[3]),
      preCutoverInvocationId: argv[4],
    });
    process.stdout.write([
      "credential_provider_materialization=complete",
      `transaction_id=${result.transactionId}`,
      `provider_identity_receipt_sha256=${result.providerIdentityReceiptSha256}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 5 && argv[0] === "prepare") {
    const result = await prepareInstalledCredentialAttestation({
      candidateSha: argv[1],
      runId: argv[2],
      runAttempt: Number(argv[3]),
      preCutoverInvocationId: argv[4],
    });
    process.stdout.write([
      `credential_live_state=PREPARED`,
      `transaction_id=${result.transactionId}`,
      `precheck_sha256=${result.precheckSha256}`,
      `ci_run_attempt=${result.runAttempt}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 5 && argv[0] === "expire-prepared") {
    const result = expirePreparedCredentialAttestation({
      candidateSha: argv[1],
      runId: argv[2],
      runAttempt: Number(argv[3]),
      preCutoverInvocationId: argv[4],
    });
    process.stdout.write([
      "credential_live_state=EXPIRED",
      `transaction_id=${result.transactionId}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 5 && argv[0] === "prove-revocation") {
    const result = await produceInstalledRevocationProof({
      candidateSha: argv[1],
      runId: argv[2],
      runAttempt: Number(argv[3]),
      postCutoverInvocationId: argv[4],
    });
    process.stdout.write([
      `credential_live_state=CUTOVER_INFLIGHT`,
      `transaction_id=${result.transactionId}`,
      `revocation_proof_sha256=${result.revocationProofSha256}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 5 && argv[0] === "complete") {
    const result = await produceInstalledCompletion({
      candidateSha: argv[1],
      runId: argv[2],
      runAttempt: Number(argv[3]),
      postCutoverInvocationId: argv[4],
    });
    process.stdout.write([
      `credential_live_state=COMPLETE`,
      `transaction_id=${result.transactionId}`,
      `completion_sha256=${result.completionSha256}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 6 && argv[0] === "readback") {
    const result = await produceInstalledReadback({
      remediationSha: argv[1],
      releaseSha: argv[2],
      runId: argv[3],
      runAttempt: Number(argv[4]),
      postCutoverInvocationId: argv[5],
    });
    process.stdout.write([
      `credential_live_state=COMPLETE`,
      `transaction_id=${result.transactionId}`,
      `readback_sha256=${result.readbackSha256}`,
    ].join("\n") + "\n");
    return 0;
  }
  if (argv.length === 6 && argv[0] === "consume") {
    const result = await consumeInstalledCredentialAttestation({
      remediationSha: argv[1],
      releaseSha: argv[2],
      runId: argv[3],
      runAttempt: Number(argv[4]),
      postCutoverInvocationId: argv[5],
    });
    process.stdout.write([
      `credential_live_state=CONSUMED`,
      `transaction_id=${result.transactionId}`,
      `tombstone_sha256=${result.tombstoneSha256}`,
    ].join("\n") + "\n");
    return 0;
  }
  process.stderr.write("credential live attestation failed: usage_invalid\n");
  return 64;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const code = error instanceof CredentialLiveError ? error.code : "unexpected_failure";
    process.stderr.write(`credential live attestation failed: ${code}\n`);
    process.exitCode = 1;
  });
}
