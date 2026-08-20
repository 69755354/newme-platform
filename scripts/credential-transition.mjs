#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  fchmodSync,
  fchownSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_LOCK = "/run/lock/newme-production-release.lock";
export const PRODUCTION_PATHS = Object.freeze({
  runtimeDir: "/etc/newme",
  runtime: "/etc/newme/newme-runtime.env",
  runtimeNext: "/etc/newme/newme-runtime.env.credential-transition.next",
  runtimeAdoptNext: "/etc/newme/newme-runtime.env.credential-adopt.next",
  inboxDir: "/run/newme-credential-inbox",
  inbox: "/run/newme-credential-inbox/supabase-service-key.env",
  stateDir: "/var/lib/newme/deploy-state",
  pending: "/var/lib/newme/deploy-state/credential-transition.pending.json",
  pendingNext: "/var/lib/newme/deploy-state/credential-transition.pending.next",
  systemdPending: "/var/lib/newme/deploy-state/systemd-assets.pending",
  credentialAssetsPending: "/var/lib/newme/deploy-state/credential-assets.pending",
  productionRollbackPending: "/var/lib/newme/deploy-state/production-rollback.pending",
  backup: "/var/lib/newme/deploy-state/credential-transition.previous.env",
  backupPreparing: "/var/lib/newme/deploy-state/credential-transition.previous.env.preparing",
  last: "/var/lib/newme/deploy-state/credential-transition.last.json",
  lastNext: "/var/lib/newme/deploy-state/credential-transition.last.next",
  adoptPending: "/var/lib/newme/deploy-state/credential-adopt.pending.json",
  adoptPendingNext: "/var/lib/newme/deploy-state/credential-adopt.pending.next",
  adoptBackup: "/var/lib/newme/deploy-state/credential-adopt.previous.env",
  adoptBackupPreparing: "/var/lib/newme/deploy-state/credential-adopt.previous.env.preparing",
  adoptLast: "/var/lib/newme/deploy-state/credential-adopt.last.json",
  adoptLastNext: "/var/lib/newme/deploy-state/credential-adopt.last.next",
  protection: "/var/lib/newme/deploy-state/credential-remediation.protected.json",
  protectionNext: "/var/lib/newme/deploy-state/credential-remediation.protected.next",
  releaseEnv: "/opt/newme/current/.env.local",
  unit: "/etc/systemd/system/newme-platform.service",
  validator: "/usr/local/libexec/newme/newme-validate-production-config.py",
  readiness: "/usr/local/libexec/newme/newme-readiness.sh",
  python: "/usr/bin/python3",
  systemctl: "/usr/bin/systemctl",
});
export const PROTECTED_VERSIONED_ASSETS = Object.freeze({
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
const LEGACY_PROTECTED_VERSIONED_ASSET_PATHS = Object.freeze([
  "/etc/systemd/system/newme-platform.service",
  "/etc/tmpfiles.d/newme-credential-inbox.conf",
  "/etc/cron.d/newme-observability",
  "/usr/local/sbin/newme-deploy",
  "/usr/local/sbin/newme-production-rollback",
  "/usr/local/libexec/newme/newme-install-systemd-assets",
  "/usr/local/libexec/newme/newme-rollback-systemd-assets",
  "/usr/local/libexec/newme/newme-validate-production-config.py",
  "/usr/local/libexec/newme/newme-credential-transition.mjs",
  "/usr/local/libexec/newme/newme-readiness.sh",
  "/opt/hermes-scripts/observability/dependency-probe.sh",
].sort());

const SAFE_CHILD_ENV = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});
const SERVICE_ASSIGNMENT = /^[\t ]*(?:export[\t ]+)?SUPABASE_SERVICE_ROLE_KEY[\t ]*=/;
const INBOX_ASSIGNMENT = /^SUPABASE_SERVICE_ROLE_KEY=([A-Za-z0-9._-]{20,2048})\n?$/;
const SERVICE_VALUE_PATTERN = /^[A-Za-z0-9._-]{20,2048}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_PATTERN = /^[1-9][0-9]*$/;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PHASES = new Set([
  "prepared",
  "runtime_switched",
  "restart_failed",
  "healthy",
  "awaiting_provider_revocation",
  "recovery_failed",
]);

export class TransitionError extends Error {
  constructor(code) {
    super(code);
    this.name = "TransitionError";
    this.code = code;
  }
}

function refuse(code) {
  throw new TransitionError(code);
}

function modeOf(metadata) {
  return metadata.mode & 0o777;
}

export function assertMetadata(
  metadata,
  { kind, modes, label, enforceRoot = true, enforceMode = true },
) {
  const kindMatches = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!kindMatches || metadata.isSymbolicLink()) {
    refuse(`${label}_type_invalid`);
  }
  if (enforceRoot && (metadata.uid !== 0 || metadata.gid !== 0)) {
    refuse(`${label}_ownership_invalid`);
  }
  if (enforceMode && !modes.includes(modeOf(metadata))) {
    refuse(`${label}_mode_invalid`);
  }
}

function requireNode(path, specification, options) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    refuse(`${specification.label}_missing`);
  }
  assertMetadata(metadata, {
    ...specification,
    enforceRoot: options.securityChecks,
    enforceMode: options.securityChecks,
  });
  return metadata;
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    refuse("filesystem_metadata_failed");
  }
}

function readBounded(path, maximum, code) {
  const metadata = lstatSync(path);
  if (metadata.size <= 0 || metadata.size > maximum) refuse(code);
  const value = readFileSync(path, "utf8");
  if (value.includes("\0")) refuse(code);
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fsyncDirectory(path, options) {
  if (!options.durable) return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path, value, options) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, value, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    if (options.securityChecks) fchownSync(descriptor, 0, 0);
    if (options.durable) fsyncSync(descriptor);
  } catch {
    refuse("durable_write_failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function replaceAtomically(destination, staging, value, directory, options) {
  if (pathEntryExists(staging)) refuse("staging_file_already_exists");
  writeExclusive(staging, value, options);
  try {
    if (!options.durable && pathEntryExists(destination)) unlinkSync(destination);
    renameSync(staging, destination);
    fsyncDirectory(directory, options);
  } catch {
    refuse("atomic_replace_failed");
  }
}

function removeDurably(path, directory, options) {
  if (!pathEntryExists(path)) return;
  try {
    unlinkSync(path);
    fsyncDirectory(directory, options);
  } catch {
    refuse("durable_remove_failed");
  }
}

function removeExpectedDurably(path, directory, quarantine, specification, options) {
  const sourceExists = pathEntryExists(path);
  const quarantineExists = pathEntryExists(quarantine);
  if (sourceExists && quarantineExists) refuse(`${specification.label}_consume_conflict`);
  if (!sourceExists && !quarantineExists) return false;

  if (sourceExists) {
    requireNode(path, {
      kind: "file",
      modes: specification.modes,
      label: specification.label,
    }, options);
    try {
      renameSync(path, quarantine);
      fsyncDirectory(directory, options);
    } catch {
      refuse(`${specification.label}_consume_failed`);
    }
  }

  try {
    requireNode(quarantine, {
      kind: "file",
      modes: specification.modes,
      label: `${specification.label}_quarantine`,
    }, options);
    const value = readBounded(quarantine, specification.maximum, `${specification.label}_invalid`);
    specification.validate(value);
  } catch (error) {
    if (!pathEntryExists(path) && pathEntryExists(quarantine)) {
      try {
        renameSync(quarantine, path);
        fsyncDirectory(directory, options);
      } catch {
        refuse(`${specification.label}_restore_failed`);
      }
    }
    throw error;
  }

  removeDurably(quarantine, directory, options);
  return true;
}

function commitRuntime(staging, runtime, options) {
  try {
    if (!options.durable && pathEntryExists(runtime)) unlinkSync(runtime);
    renameSync(staging, runtime);
    fsyncDirectory(dirname(runtime), options);
  } catch {
    refuse("runtime_replace_failed");
  }
}

function secureCleanup(path, directory, label, options) {
  if (!pathEntryExists(path)) return;
  requireNode(path, { kind: "file", modes: [0o600], label }, options);
  removeDurably(path, directory, options);
}

function pendingPayload(record) {
  return `${JSON.stringify(record)}\n`;
}

function writePending(record, paths, options) {
  secureCleanup(paths.pendingNext, paths.stateDir, "pending_staging", options);
  replaceAtomically(
    paths.pending,
    paths.pendingNext,
    pendingPayload(record),
    paths.stateDir,
    options,
  );
}

function writeLast(status, record, paths, options) {
  const last = {
    version: 1,
    status,
    transaction_id: record.transaction_id,
    precheck_sha256: record.precheck_sha256,
    candidate_sha: record.candidate_sha,
    ci_run_id: record.ci_run_id,
    ci_run_attempt: record.ci_run_attempt,
    finished_at: options.now(),
    before_sha256: record.before_sha256,
    after_sha256: record.after_sha256,
  };
  secureCleanup(paths.lastNext, paths.stateDir, "last_staging", options);
  replaceAtomically(
    paths.last,
    paths.lastNext,
    pendingPayload(last),
    paths.stateDir,
    options,
  );
}

function awaitingLastPayload(record) {
  return `${JSON.stringify({
    version: 1,
    status: "awaiting_provider_revocation",
    transaction_id: record.transaction_id,
    precheck_sha256: record.precheck_sha256,
    candidate_sha: record.candidate_sha,
    ci_run_id: record.ci_run_id,
    ci_run_attempt: record.ci_run_attempt,
    finished_at: record.finished_at,
    before_sha256: record.before_sha256,
    after_sha256: record.after_sha256,
  })}\n`;
}

function writeLiveCompleteLast(record, {
  awaitingLastSha256,
  completionSha256,
}, paths, options) {
  const last = {
    version: 1,
    status: "complete",
    transaction_id: record.transaction_id,
    precheck_sha256: record.precheck_sha256,
    candidate_sha: record.candidate_sha,
    ci_run_id: record.ci_run_id,
    ci_run_attempt: record.ci_run_attempt,
    finished_at: record.finished_at,
    before_sha256: record.before_sha256,
    after_sha256: record.after_sha256,
    awaiting_last_sha256: awaitingLastSha256,
    completion_sha256: completionSha256,
    finalized_at: options.now(),
  };
  secureCleanup(paths.lastNext, paths.stateDir, "last_staging", options);
  replaceAtomically(
    paths.last,
    paths.lastNext,
    pendingPayload(last),
    paths.stateDir,
    options,
  );
  return last;
}

function parsePending(paths, options) {
  requireNode(paths.pending, { kind: "file", modes: [0o600], label: "pending" }, options);
  let record;
  try {
    record = JSON.parse(readBounded(paths.pending, 16384, "pending_invalid"));
  } catch (error) {
    if (error instanceof TransitionError) throw error;
    refuse("pending_invalid");
  }
  const expectedKeys = [
    "after_sha256",
    "before_sha256",
    "candidate_sha",
    "ci_run_attempt",
    "ci_run_id",
    "phase",
    "precheck_sha256",
    "protection_before",
    "started_at",
    "transaction_id",
    "version",
  ];
  if (
    record === null ||
    Array.isArray(record) ||
    typeof record !== "object" ||
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys) ||
    record.version !== 1 ||
    !PHASES.has(record.phase) ||
    !SHA_PATTERN.test(record.candidate_sha) ||
    !RUN_PATTERN.test(record.ci_run_id) ||
    !RUN_ATTEMPT_PATTERN.test(String(record.ci_run_attempt)) ||
    !TRANSACTION_ID_PATTERN.test(record.transaction_id) ||
    !DIGEST_PATTERN.test(record.precheck_sha256) ||
    !TIMESTAMP_PATTERN.test(record.started_at) ||
    !DIGEST_PATTERN.test(record.before_sha256) ||
    !DIGEST_PATTERN.test(record.after_sha256) ||
    record.before_sha256 === record.after_sha256 ||
    !isValidProtectionSnapshot(record.protection_before)
  ) {
    refuse("pending_invalid");
  }
  return record;
}

function parseLast(paths, options) {
  if (!pathEntryExists(paths.last)) return null;
  requireNode(paths.last, { kind: "file", modes: [0o600], label: "last_record" }, options);
  let record;
  try {
    record = JSON.parse(readBounded(paths.last, 4096, "last_record_invalid"));
  } catch (error) {
    if (error instanceof TransitionError) throw error;
    refuse("last_record_invalid");
  }
  const awaitingKeys = [
    "after_sha256",
    "before_sha256",
    "candidate_sha",
    "ci_run_attempt",
    "ci_run_id",
    "finished_at",
    "precheck_sha256",
    "status",
    "transaction_id",
    "version",
  ];
  const completeKeys = [
    ...awaitingKeys,
    "awaiting_last_sha256",
    "completion_sha256",
    "finalized_at",
  ];
  const isComplete = record?.status === "complete";
  if (
    record === null ||
    Array.isArray(record) ||
    typeof record !== "object" ||
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify((isComplete ? completeKeys : awaitingKeys).sort()) ||
    record.version !== 1 ||
    !new Set(["awaiting_provider_revocation", "rolled_back", "interrupted_before_switch", "complete"]).has(record.status) ||
    !SHA_PATTERN.test(record.candidate_sha) ||
    !RUN_PATTERN.test(record.ci_run_id) ||
    !RUN_ATTEMPT_PATTERN.test(String(record.ci_run_attempt)) ||
    !TRANSACTION_ID_PATTERN.test(record.transaction_id) ||
    !DIGEST_PATTERN.test(record.precheck_sha256) ||
    !TIMESTAMP_PATTERN.test(record.finished_at) ||
    !DIGEST_PATTERN.test(record.before_sha256) ||
    !DIGEST_PATTERN.test(record.after_sha256) ||
    (isComplete && (
      !DIGEST_PATTERN.test(record.awaiting_last_sha256) ||
      !DIGEST_PATTERN.test(record.completion_sha256) ||
      !TIMESTAMP_PATTERN.test(record.finalized_at) ||
      digest(awaitingLastPayload(record)) !== record.awaiting_last_sha256
    ))
  ) {
    refuse("last_record_invalid");
  }
  return record;
}

function isValidProtectionRecord(record) {
  if (record === null || Array.isArray(record) || typeof record !== "object") return false;
  const commonValid =
    SHA_PATTERN.test(record.candidate_sha) &&
    TIMESTAMP_PATTERN.test(record.activated_at);
  if (!commonValid) return false;
  if (record.version === 1) {
    return JSON.stringify(Object.keys(record).sort()) ===
      JSON.stringify(["activated_at", "candidate_sha", "version"]);
  }
  const expectedAssetPaths = Object.keys(PROTECTED_VERSIONED_ASSETS).sort();
  const actualAssetPaths = record.assets !== null && !Array.isArray(record.assets) && typeof record.assets === "object"
    ? Object.keys(record.assets).sort()
    : [];
  return record.version === 2 &&
    JSON.stringify(Object.keys(record).sort()) ===
      JSON.stringify(["activated_at", "assets", "candidate_sha", "version"]) &&
    record.assets !== null &&
    !Array.isArray(record) &&
    typeof record.assets === "object" &&
    (
      JSON.stringify(actualAssetPaths) === JSON.stringify(expectedAssetPaths) ||
      JSON.stringify(actualAssetPaths) === JSON.stringify(LEGACY_PROTECTED_VERSIONED_ASSET_PATHS)
    ) &&
    Object.values(record.assets).every((value) => typeof value === "string" && DIGEST_PATTERN.test(value));
}

function isValidProtectionSnapshot(snapshot) {
  if (snapshot === null) return true;
  if (typeof snapshot !== "string" || snapshot.length <= 0 || snapshot.length > 8192 || snapshot.includes("\0")) {
    return false;
  }
  try {
    return isValidProtectionRecord(JSON.parse(snapshot));
  } catch {
    return false;
  }
}

function parseProtection(paths, options) {
  if (!pathEntryExists(paths.protection)) return null;
  requireNode(paths.protection, { kind: "file", modes: [0o600], label: "protection_record" }, options);
  let record;
  try {
    record = JSON.parse(readBounded(paths.protection, 8192, "protection_record_invalid"));
  } catch (error) {
    if (error instanceof TransitionError) throw error;
    refuse("protection_record_invalid");
  }
  if (!isValidProtectionRecord(record)) {
    refuse("protection_record_invalid");
  }
  return record;
}

function snapshotProtection(paths, options) {
  const existing = parseProtection(paths, options);
  if (existing === null) return null;
  return readBounded(paths.protection, 8192, "protection_record_invalid");
}

function ensureProtection(record, paths, options) {
  const existing = parseProtection(paths, options);
  const assets = options.protectedAssetDigests();
  if (!isValidProtectionRecord({
    version: 2,
    candidate_sha: record.candidate_sha,
    activated_at: options.now(),
    assets,
  })) refuse("protected_asset_digest_set_invalid");
  if (
    existing?.version === 2 &&
    existing.candidate_sha === record.candidate_sha &&
    JSON.stringify(existing.assets) === JSON.stringify(assets)
  ) return;
  secureCleanup(paths.protectionNext, paths.stateDir, "protection_staging", options);
  replaceAtomically(
    paths.protection,
    paths.protectionNext,
    pendingPayload({
      version: 2,
      candidate_sha: record.candidate_sha,
      activated_at: options.now(),
      assets,
    }),
    paths.stateDir,
    options,
  );
}

function restoreProtectionSnapshot(record, paths, options) {
  secureCleanup(paths.protectionNext, paths.stateDir, "protection_staging", options);
  if (record.protection_before === null) {
    removeDurably(paths.protection, paths.stateDir, options);
    return;
  }
  replaceAtomically(
    paths.protection,
    paths.protectionNext,
    record.protection_before,
    paths.stateDir,
    options,
  );
}

function parseInbox(paths, options) {
  requireNode(paths.inbox, { kind: "file", modes: [0o400, 0o600], label: "inbox" }, options);
  const content = readBounded(paths.inbox, 4096, "inbox_invalid");
  const match = INBOX_ASSIGNMENT.exec(content);
  if (!match) refuse("inbox_invalid");
  return {
    assignment: `SUPABASE_SERVICE_ROLE_KEY=${match[1]}`,
    content,
    valueSha256: digest(match[1]),
  };
}

// Every service-key assignment in an environment file, parsed the way systemd
// and the validator read one. Shared by the rotation (which needs the digest of
// the single runtime value) and the adoption (which needs the value itself, from
// the live release environment) so the two can never disagree about what counts
// as an assignment.
function serviceAssignmentValues(content, label) {
  const values = [];
  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== "SUPABASE_SERVICE_ROLE_KEY") continue;
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["\"", "'"].includes(value[0])) {
      value = value.slice(1, -1);
    }
    if (!SERVICE_VALUE_PATTERN.test(value)) refuse(`${label}_service_key_invalid`);
    values.push(value);
  }
  return values;
}

function runtimeServiceKeyDigest(runtime) {
  const values = serviceAssignmentValues(runtime, "runtime");
  if (values.length !== 1) refuse(values.length === 0 ? "runtime_service_key_missing" : "runtime_service_key_duplicate");
  return digest(values[0]);
}

function renderRuntime(runtime, assignment) {
  const lines = runtime.replace(/\r\n/g, "\n").split("\n");
  const retained = lines.filter((line) => !SERVICE_ASSIGNMENT.test(line));
  const base = retained.join("\n").replace(/\n+$/u, "");
  return `${base}${base ? "\n" : ""}${assignment}\n`;
}

function runSilently(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    env: SAFE_CHILD_ENV,
    stdio: "ignore",
    windowsHide: true,
    ...extra,
  });
  if (result.error || result.status !== 0) refuse("subprocess_failed");
}

export function assertFixedRuntimeEnvironmentFile(unit) {
  const environmentFiles = unit
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("EnvironmentFile="));
  if (
    environmentFiles.length !== 1 ||
    environmentFiles[0] !== "EnvironmentFile=/etc/newme/newme-runtime.env"
  ) {
    refuse("service_unit_runtime_store_invalid");
  }
}

function validateServiceConfigurationDefault(paths) {
  const unit = readBounded(paths.unit, 65536, "service_unit_invalid");
  assertFixedRuntimeEnvironmentFile(unit);
  const result = spawnSync(paths.systemctl, [
    "show",
    "newme-platform.service",
    "--property=FragmentPath",
    "--property=DropInPaths",
  ], {
    encoding: "utf8",
    env: SAFE_CHILD_ENV,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) refuse("service_configuration_query_failed");
  const properties = Object.fromEntries(
    result.stdout.trim().split(/\r?\n/u).map((line) => line.split("=", 2)),
  );
  if (
    properties.FragmentPath !== paths.unit ||
    properties.DropInPaths !== ""
  ) {
    refuse("service_configuration_drifted");
  }
}

function validateCandidateDefault(candidate, paths) {
  runSilently(paths.python, [
    paths.validator,
    "--release-env",
    paths.releaseEnv,
    "--runtime-env",
    candidate,
    "--require-runtime-service-key",
    "--network",
  ]);
}

function restartAndVerifyDefault(paths) {
  runSilently(paths.systemctl, ["restart", "newme-platform.service"]);
  runSilently(paths.systemctl, ["is-active", "--quiet", "newme-platform.service"]);
  runSilently(paths.readiness, []);
}

function protectedAssetDigestsDefault(options) {
  const assets = {};
  for (const [path, mode] of Object.entries(PROTECTED_VERSIONED_ASSETS)) {
    requireNode(path, { kind: "file", modes: [mode], label: "protected_asset" }, options);
    assets[path] = digest(readBounded(path, 2 * 1024 * 1024, "protected_asset_invalid"));
  }
  return assets;
}

function normalizedOptions(overrides = {}) {
  const options = {
    securityChecks: overrides.securityChecks ?? true,
    durable: overrides.durable ?? true,
    now: overrides.now ?? (() => new Date().toISOString()),
    validateCandidate: overrides.validateCandidate ?? validateCandidateDefault,
    restartAndVerify: overrides.restartAndVerify ?? restartAndVerifyDefault,
    validateServiceConfiguration:
      overrides.validateServiceConfiguration ?? validateServiceConfigurationDefault,
    checkpoint: overrides.checkpoint ?? (() => {}),
  };
  options.protectedAssetDigests = overrides.protectedAssetDigests ??
    (() => protectedAssetDigestsDefault(options));
  return options;
}

export function refreshCredentialProtection({ sha, paths = PRODUCTION_PATHS, ...overrides }) {
  if (!SHA_PATTERN.test(sha)) refuse("arguments_invalid");
  const options = normalizedOptions(overrides);
  requireNode(paths.stateDir, { kind: "directory", modes: [0o700], label: "state_directory" }, options);
  if (parseProtection(paths, options) === null) refuse("protection_record_missing");
  ensureProtection({ candidate_sha: sha }, paths, options);
  return { status: "complete" };
}

function validateStaticPaths(paths, options, requireInbox, allowedInboxEntries = []) {
  requireNode(paths.stateDir, { kind: "directory", modes: [0o700], label: "state_directory" }, options);
  requireNode(paths.inboxDir, { kind: "directory", modes: [0o700], label: "inbox_directory" }, options);
  requireNode(paths.runtimeDir, { kind: "directory", modes: [0o700, 0o750], label: "runtime_directory" }, options);
  requireNode(paths.runtime, { kind: "file", modes: [0o600], label: "runtime" }, options);
  const releaseMetadata = requireNode(paths.releaseEnv, { kind: "file", modes: [0o400, 0o600, 0o640, 0o644], label: "release_environment" }, {
    ...options,
    securityChecks: false,
  });
  if (options.securityChecks && (modeOf(releaseMetadata) & 0o022) !== 0) {
    refuse("release_environment_mode_invalid");
  }
  if (options.securityChecks) {
    requireNode(paths.unit, { kind: "file", modes: [0o644], label: "service_unit" }, options);
    requireNode(paths.validator, { kind: "file", modes: [0o755], label: "validator" }, options);
    requireNode(paths.readiness, { kind: "file", modes: [0o755], label: "readiness" }, options);
    options.validateServiceConfiguration(paths);
  }
  let inboxEntries;
  try {
    inboxEntries = readdirSync(paths.inboxDir);
  } catch {
    refuse("inbox_directory_read_failed");
  }
  const expectedInbox = basename(paths.inbox);
  const allowedEntries = new Set([expectedInbox, ...allowedInboxEntries]);
  if (
    inboxEntries.some((entry) => !allowedEntries.has(entry)) ||
    (requireInbox && (inboxEntries.length !== 1 || inboxEntries[0] !== expectedInbox))
  ) {
    refuse("inbox_directory_not_single_use");
  }
}

function cleanupUncommittedFiles(paths, options) {
  secureCleanup(paths.runtimeNext, dirname(paths.runtime), "runtime_staging", options);
  secureCleanup(paths.backupPreparing, paths.stateDir, "backup_staging", options);
  secureCleanup(paths.pendingNext, paths.stateDir, "pending_staging", options);
  secureCleanup(paths.lastNext, paths.stateDir, "last_staging", options);
  secureCleanup(paths.protectionNext, paths.stateDir, "protection_staging", options);
}

function cleanupOrphanBackup(paths, options) {
  if (!pathEntryExists(paths.backup)) return;
  requireNode(paths.backup, { kind: "file", modes: [0o600], label: "orphan_backup" }, options);
  const runtime = readBounded(paths.runtime, 262144, "runtime_invalid");
  const backup = readBounded(paths.backup, 262144, "backup_invalid");
  const runtimeDigest = digest(runtime);
  const backupDigest = digest(backup);
  if (runtimeDigest !== backupDigest) {
    // A historical last.status=complete only proved local runtime health. It is
    // not a provider-side revocation receipt and cannot authorise deleting the
    // only preserved identity for the old service key. A future live finalizer
    // may remove this backup only after it has verified the signed completion
    // bound to this exact transition.
    refuse("orphan_backup_requires_live_completion");
  }
  removeDurably(paths.backup, paths.stateDir, options);
}

function transitionRecord(sha, runId, runAttempt, transactionId, precheckSha256, before, after, protectionBefore, options) {
  return {
    version: 1,
    phase: "prepared",
    protection_before: protectionBefore,
    transaction_id: transactionId,
    precheck_sha256: precheckSha256,
    candidate_sha: sha,
    ci_run_id: runId,
    ci_run_attempt: runAttempt,
    started_at: options.now(),
    before_sha256: digest(before),
    after_sha256: digest(after),
  };
}

function assertInboxStillMatchesCandidate(record, paths, options) {
  const inbox = parseInbox(paths, options);
  requireNode(paths.backup, { kind: "file", modes: [0o600], label: "backup" }, options);
  const before = readBounded(paths.backup, 262144, "backup_invalid");
  if (digest(renderRuntime(before, inbox.assignment)) !== record.after_sha256) {
    refuse("inbox_candidate_digest_mismatch");
  }
}

function assertRuntimeAndInboxStillMatchCandidate(record, paths, options) {
  const runtime = readBounded(paths.runtime, 262144, "runtime_invalid");
  if (digest(runtime) !== record.after_sha256) {
    refuse("runtime_candidate_digest_mismatch");
  }
  assertInboxStillMatchesCandidate(record, paths, options);
}

function completeRollback(record, paths, options) {
  restoreProtectionSnapshot(record, paths, options);
  writeLast("rolled_back", record, paths, options);
  removeDurably(paths.pending, paths.stateDir, options);
  options.checkpoint("after_pending_removed");
  removeDurably(paths.backup, paths.stateDir, options);
  cleanupUncommittedFiles(paths, options);
}

function restorePrevious(record, paths, options) {
  requireNode(paths.backup, { kind: "file", modes: [0o600], label: "backup" }, options);
  const previous = readBounded(paths.backup, 262144, "backup_invalid");
  if (digest(previous) !== record.before_sha256) refuse("backup_digest_mismatch");
  secureCleanup(paths.runtimeNext, dirname(paths.runtime), "runtime_staging", options);
  writeExclusive(paths.runtimeNext, previous, options);
  commitRuntime(paths.runtimeNext, paths.runtime, options);
  try {
    options.restartAndVerify(paths);
  } catch {
    record.phase = "recovery_failed";
    writePending(record, paths, options);
    refuse("credential_recovery_failed");
  }
  completeRollback(record, paths, options);
  return { status: "rolled_back" };
}

const ADOPT_PHASES = new Set([
  "prepared",
  "runtime_switched",
  "restart_failed",
  "healthy",
  "recovery_failed",
]);

function adoptRecord(sha, before, after, options) {
  return {
    version: 1,
    kind: "service_key_store_adoption",
    phase: "prepared",
    candidate_sha: sha,
    started_at: options.now(),
    before_sha256: digest(before),
    after_sha256: digest(after),
  };
}

function writeAdoptPending(record, paths, options) {
  secureCleanup(paths.adoptPendingNext, paths.stateDir, "adopt_pending_staging", options);
  replaceAtomically(
    paths.adoptPending,
    paths.adoptPendingNext,
    pendingPayload(record),
    paths.stateDir,
    options,
  );
}

function writeAdoptLast(status, record, paths, options) {
  const last = {
    version: 1,
    kind: "service_key_store_adoption",
    status,
    candidate_sha: record.candidate_sha,
    started_at: record.started_at,
    finished_at: options.now(),
    before_sha256: record.before_sha256,
    after_sha256: record.after_sha256,
  };
  secureCleanup(paths.adoptLastNext, paths.stateDir, "adopt_last_staging", options);
  replaceAtomically(
    paths.adoptLast,
    paths.adoptLastNext,
    `${JSON.stringify(last)}\n`,
    paths.stateDir,
    options,
  );
}

function parseAdoptPending(paths, options) {
  requireNode(paths.adoptPending, { kind: "file", modes: [0o600], label: "adopt_pending" }, options);
  const raw = readBounded(paths.adoptPending, 65536, "adopt_pending_invalid");
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    refuse("adopt_pending_invalid");
  }
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.version !== 1 ||
    record.kind !== "service_key_store_adoption" ||
    !ADOPT_PHASES.has(record.phase) ||
    !SHA_PATTERN.test(record.candidate_sha ?? "") ||
    !TIMESTAMP_PATTERN.test(record.started_at ?? "") ||
    !DIGEST_PATTERN.test(record.before_sha256 ?? "") ||
    !DIGEST_PATTERN.test(record.after_sha256 ?? "") ||
    record.before_sha256 === record.after_sha256 ||
    raw !== pendingPayload(record)
  ) {
    refuse("adopt_pending_invalid");
  }
  return record;
}

function cleanupAdoptStaging(paths, options) {
  secureCleanup(paths.runtimeAdoptNext, dirname(paths.runtime), "adopt_runtime_staging", options);
  secureCleanup(paths.adoptBackupPreparing, paths.stateDir, "adopt_backup_staging", options);
  secureCleanup(paths.adoptPendingNext, paths.stateDir, "adopt_pending_staging", options);
  secureCleanup(paths.adoptLastNext, paths.stateDir, "adopt_last_staging", options);
}

// The preserved copy is the runtime file *before* adoption, which by definition
// carries no service credential -- the value it gains is the one the live
// release still holds. Discarding it after a healthy switch therefore destroys
// no identity, which is why this is safe here and deliberately forbidden for the
// rotation's backup (that one is the only remaining record of a key awaiting
// provider-side revocation).
function finishAdoption(status, record, paths, options) {
  writeAdoptLast(status, record, paths, options);
  removeDurably(paths.adoptPending, paths.stateDir, options);
  removeDurably(paths.adoptBackup, paths.stateDir, options);
  cleanupAdoptStaging(paths, options);
  return { status };
}

function restoreAdoptPrevious(record, paths, options) {
  requireNode(paths.adoptBackup, { kind: "file", modes: [0o600], label: "adopt_backup" }, options);
  const previous = readBounded(paths.adoptBackup, 262144, "adopt_backup_invalid");
  if (digest(previous) !== record.before_sha256) refuse("adopt_backup_digest_mismatch");
  secureCleanup(paths.runtimeAdoptNext, dirname(paths.runtime), "adopt_runtime_staging", options);
  writeExclusive(paths.runtimeAdoptNext, previous, options);
  commitRuntime(paths.runtimeAdoptNext, paths.runtime, options);
  try {
    options.restartAndVerify(paths);
  } catch {
    record.phase = "recovery_failed";
    writeAdoptPending(record, paths, options);
    refuse("adopt_recovery_failed");
  }
  return finishAdoption("rolled_back", record, paths, options);
}

// Relocation, not rotation. The deploy contract introduced by the server-side
// login change requires the server credential to live only in the fixed
// root-only runtime store; a production host that still keeps it in the live
// release environment cannot deploy that contract at all, because the candidate
// environment is stripped and the validator then finds nothing in the store.
// This moves the value already in use, under the same transactional discipline
// as the rotation, and asserts nothing about the provider.
export function adoptServiceKeyStore({ sha, paths = PRODUCTION_PATHS, ...overrides }) {
  if (!SHA_PATTERN.test(sha ?? "")) refuse("arguments_invalid");
  const options = normalizedOptions(overrides);
  validateStaticPaths(paths, options, false);
  // A staged replacement means a rotation is in flight or half-finished. Reading
  // the live value while that is true would relocate the wrong credential.
  if (pathEntryExists(paths.inbox)) refuse("rotation_input_present");
  if (pathEntryExists(paths.adoptPending)) refuse("pending_adoption_requires_recovery");
  if (pathEntryExists(paths.pending)) refuse("pending_transition_requires_recovery");
  if (pathEntryExists(paths.backup)) refuse("pending_transition_requires_recovery");
  if (
    pathEntryExists(paths.systemdPending) ||
    pathEntryExists(paths.credentialAssetsPending) ||
    pathEntryExists(paths.productionRollbackPending)
  ) {
    refuse("another_release_transaction_requires_recovery");
  }
  const runtime = readBounded(paths.runtime, 262144, "runtime_invalid");
  if (serviceAssignmentValues(runtime, "runtime").length !== 0) {
    refuse("runtime_service_key_already_present");
  }
  const releaseValues = serviceAssignmentValues(
    readBounded(paths.releaseEnv, 262144, "release_environment_invalid"),
    "release_environment",
  );
  if (releaseValues.length !== 1) {
    refuse(releaseValues.length === 0
      ? "release_service_key_missing"
      : "release_service_key_duplicate");
  }
  const replacement = renderRuntime(runtime, `SUPABASE_SERVICE_ROLE_KEY=${releaseValues[0]}`);
  if (digest(replacement) === digest(runtime)) refuse("adoption_would_not_change_runtime");

  cleanupAdoptStaging(paths, options);
  if (pathEntryExists(paths.adoptBackup)) refuse("orphan_adoption_backup_requires_recovery");

  writeExclusive(paths.runtimeAdoptNext, replacement, options);
  try {
    // The validator's --network probe is the positive control: it proves the
    // relocated value still authenticates against the project as a server-only
    // key, before anything is switched.
    options.validateCandidate(paths.runtimeAdoptNext, paths);
  } catch {
    secureCleanup(paths.runtimeAdoptNext, dirname(paths.runtime), "adopt_runtime_staging", options);
    refuse("candidate_config_validation_failed");
  }

  writeExclusive(paths.adoptBackupPreparing, runtime, options);
  renameSync(paths.adoptBackupPreparing, paths.adoptBackup);
  fsyncDirectory(paths.stateDir, options);
  options.checkpoint("after_backup");

  const record = adoptRecord(sha, runtime, replacement, options);
  writeAdoptPending(record, paths, options);
  options.checkpoint("after_pending");

  commitRuntime(paths.runtimeAdoptNext, paths.runtime, options);
  options.checkpoint("after_runtime_switch");

  record.phase = "runtime_switched";
  writeAdoptPending(record, paths, options);
  options.checkpoint("after_switched_record");

  try {
    options.restartAndVerify(paths);
  } catch {
    record.phase = "restart_failed";
    writeAdoptPending(record, paths, options);
    restoreAdoptPrevious(record, paths, options);
    refuse("service_verification_failed_rolled_back");
  }

  record.phase = "healthy";
  writeAdoptPending(record, paths, options);
  options.checkpoint("after_healthy_record");
  if (digest(readBounded(paths.runtime, 262144, "runtime_invalid")) !== record.after_sha256) {
    refuse("runtime_candidate_digest_mismatch");
  }
  return finishAdoption("complete", record, paths, options);
}

export function recoverServiceKeyAdoption({ paths = PRODUCTION_PATHS, ...overrides } = {}) {
  const options = normalizedOptions(overrides);
  validateStaticPaths(paths, options, false);
  if (!pathEntryExists(paths.adoptPending)) {
    cleanupAdoptStaging(paths, options);
    // A backup with no journal cannot be attributed to a runtime file by
    // guessing, and the guess that matters -- whether the store should keep the
    // credential -- is the whole point of the operation. Preserve it and stop.
    if (pathEntryExists(paths.adoptBackup)) refuse("orphan_adoption_backup_requires_operator");
    return { status: "none" };
  }
  secureCleanup(paths.adoptPendingNext, paths.stateDir, "adopt_pending_staging", options);
  const record = parseAdoptPending(paths, options);
  requireNode(paths.adoptBackup, { kind: "file", modes: [0o600], label: "adopt_backup" }, options);
  const backup = readBounded(paths.adoptBackup, 262144, "adopt_backup_invalid");
  if (digest(backup) !== record.before_sha256) refuse("adopt_backup_digest_mismatch");
  const currentDigest = digest(readBounded(paths.runtime, 262144, "runtime_invalid"));

  if (record.phase === "prepared" && currentDigest === record.before_sha256) {
    return finishAdoption("interrupted_before_switch", record, paths, options);
  }

  if (currentDigest === record.after_sha256) {
    try {
      options.restartAndVerify(paths);
    } catch {
      record.phase = "restart_failed";
      writeAdoptPending(record, paths, options);
      return restoreAdoptPrevious(record, paths, options);
    }
    return finishAdoption("complete", record, paths, options);
  }

  if (currentDigest === record.before_sha256) {
    try {
      options.restartAndVerify(paths);
    } catch {
      record.phase = "recovery_failed";
      writeAdoptPending(record, paths, options);
      refuse("adopt_recovery_failed");
    }
    return finishAdoption("rolled_back", record, paths, options);
  }

  record.phase = "recovery_failed";
  writeAdoptPending(record, paths, options);
  refuse("runtime_digest_unrecognized");
}

export function applyCredentialTransition({
  sha,
  runId,
  runAttempt,
  transactionId,
  precheckSha256,
  transitionBeforeSha256,
  transitionAfterSha256,
  paths = PRODUCTION_PATHS,
  ...overrides
}) {
  if (
    !SHA_PATTERN.test(sha) ||
    !RUN_PATTERN.test(runId) ||
    !RUN_ATTEMPT_PATTERN.test(String(runAttempt)) ||
    !TRANSACTION_ID_PATTERN.test(transactionId) ||
    !DIGEST_PATTERN.test(precheckSha256) ||
    !DIGEST_PATTERN.test(transitionBeforeSha256) ||
    !DIGEST_PATTERN.test(transitionAfterSha256) ||
    transitionBeforeSha256 === transitionAfterSha256
  ) refuse("arguments_invalid");
  const options = normalizedOptions(overrides);
  validateStaticPaths(paths, options, false);
  if (pathEntryExists(paths.pending)) refuse("pending_transition_requires_recovery");
  if (
    pathEntryExists(paths.systemdPending) ||
    pathEntryExists(paths.credentialAssetsPending) ||
    pathEntryExists(paths.productionRollbackPending)
  ) {
    refuse("another_release_transaction_requires_recovery");
  }
  const runtime = readBounded(paths.runtime, 262144, "runtime_invalid");
  if (digest(runtime) !== transitionBeforeSha256) refuse("precheck_runtime_digest_mismatch");
  const inbox = parseInbox(paths, options);
  if (runtimeServiceKeyDigest(runtime) === inbox.valueSha256) {
    refuse("replacement_matches_current_service_key");
  }
  const replacement = renderRuntime(runtime, inbox.assignment);
  if (digest(replacement) !== transitionAfterSha256) refuse("precheck_candidate_digest_mismatch");

  cleanupUncommittedFiles(paths, options);
  cleanupOrphanBackup(paths, options);

  const protectionBefore = snapshotProtection(paths, options);

  writeExclusive(paths.runtimeNext, replacement, options);
  try {
    options.validateCandidate(paths.runtimeNext, paths);
  } catch {
    secureCleanup(paths.runtimeNext, dirname(paths.runtime), "runtime_staging", options);
    refuse("candidate_config_validation_failed");
  }

  writeExclusive(paths.backupPreparing, runtime, options);
  renameSync(paths.backupPreparing, paths.backup);
  fsyncDirectory(paths.stateDir, options);
  options.checkpoint("after_backup");

  const record = transitionRecord(
    sha,
    runId,
    Number(runAttempt),
    transactionId,
    precheckSha256,
    runtime,
    replacement,
    protectionBefore,
    options,
  );
  writePending(record, paths, options);
  options.checkpoint("after_pending");

  commitRuntime(paths.runtimeNext, paths.runtime, options);
  options.checkpoint("after_runtime_switch");

  record.phase = "runtime_switched";
  writePending(record, paths, options);
  options.checkpoint("after_switched_record");

  try {
    options.restartAndVerify(paths);
  } catch {
    record.phase = "restart_failed";
    writePending(record, paths, options);
    restorePrevious(record, paths, options);
    refuse("service_verification_failed_rolled_back");
  }

  record.phase = "healthy";
  writePending(record, paths, options);
  options.checkpoint("after_healthy_record");
  assertRuntimeAndInboxStillMatchCandidate(record, paths, options);
  // Runtime health is deliberately not credential-remediation completion.
  // The old provider credentials and the GitHub secret-scanning alerts still
  // have to be independently proven revoked by the signed live-attestation
  // phase. Preserve the backup, one-use inputs, and pending journal until that
  // proof exists; removing them here used to turn a local restart into a false
  // provider-side completion claim.
  ensureProtection(record, paths, options);
  options.checkpoint("after_protection_written");
  assertRuntimeAndInboxStillMatchCandidate(record, paths, options);
  record.phase = "awaiting_provider_revocation";
  writePending(record, paths, options);
  writeLast("awaiting_provider_revocation", record, paths, options);
  options.checkpoint("after_awaiting_provider_record");
  return { status: "awaiting_provider_revocation" };
}

export function recoverCredentialTransition({ paths = PRODUCTION_PATHS, ...overrides } = {}) {
  const options = normalizedOptions(overrides);
  validateStaticPaths(paths, options, false);
  if (!pathEntryExists(paths.pending)) {
    cleanupUncommittedFiles(paths, options);
    cleanupOrphanBackup(paths, options);
    return { status: "none" };
  }
  secureCleanup(paths.pendingNext, paths.stateDir, "pending_staging", options);
  const record = parsePending(paths, options);
  requireNode(paths.backup, { kind: "file", modes: [0o600], label: "backup" }, options);
  const backup = readBounded(paths.backup, 262144, "backup_invalid");
  if (digest(backup) !== record.before_sha256) refuse("backup_digest_mismatch");
  const runtime = readBounded(paths.runtime, 262144, "runtime_invalid");
  const currentDigest = digest(runtime);

  if (record.phase === "prepared" && currentDigest === record.before_sha256) {
    writeLast("interrupted_before_switch", record, paths, options);
    removeDurably(paths.pending, paths.stateDir, options);
    removeDurably(paths.backup, paths.stateDir, options);
    cleanupUncommittedFiles(paths, options);
    return { status: "interrupted_before_switch" };
  }

  if (
    (record.phase === "healthy" || record.phase === "awaiting_provider_revocation") &&
    currentDigest === record.after_sha256
  ) {
    assertRuntimeAndInboxStillMatchCandidate(record, paths, options);
    try {
      options.restartAndVerify(paths);
    } catch {
      record.phase = "restart_failed";
      writePending(record, paths, options);
      return restorePrevious(record, paths, options);
    }
    ensureProtection(record, paths, options);
    assertRuntimeAndInboxStillMatchCandidate(record, paths, options);
    if (record.phase !== "awaiting_provider_revocation") {
      record.phase = "awaiting_provider_revocation";
      writePending(record, paths, options);
    }
    writeLast("awaiting_provider_revocation", record, paths, options);
    return { status: "awaiting_provider_revocation" };
  }

  if (currentDigest === record.before_sha256) {
    try {
      options.restartAndVerify(paths);
    } catch {
      record.phase = "recovery_failed";
      writePending(record, paths, options);
      refuse("credential_recovery_failed");
    }
    completeRollback(record, paths, options);
    return { status: "rolled_back" };
  }

  if (currentDigest !== record.after_sha256) {
    record.phase = "recovery_failed";
    writePending(record, paths, options);
    refuse("runtime_digest_unrecognized");
  }
  return restorePrevious(record, paths, options);
}

export function inspectCredentialAwaitingState({ paths = PRODUCTION_PATHS, ...overrides } = {}) {
  const options = normalizedOptions(overrides);
  validateStaticPaths(paths, options, true);
  for (const conflicting of [
    paths.pendingNext,
    paths.backupPreparing,
    paths.runtimeNext,
    paths.lastNext,
    paths.protectionNext,
    paths.systemdPending,
    paths.credentialAssetsPending,
    paths.productionRollbackPending,
  ]) {
    if (pathEntryExists(conflicting)) refuse("awaiting_state_has_conflicting_artifact");
  }
  const pending = parsePending(paths, options);
  if (pending.phase !== "awaiting_provider_revocation") refuse("transition_not_awaiting_provider_revocation");
  requireNode(paths.backup, { kind: "file", modes: [0o600], label: "backup" }, options);
  if (digest(readBounded(paths.backup, 262144, "backup_invalid")) !== pending.before_sha256) {
    refuse("backup_digest_mismatch");
  }
  assertRuntimeAndInboxStillMatchCandidate(pending, paths, options);
  const last = parseLast(paths, options);
  if (
    last === null || last.status !== "awaiting_provider_revocation" ||
    last.transaction_id !== pending.transaction_id || last.precheck_sha256 !== pending.precheck_sha256 ||
    last.candidate_sha !== pending.candidate_sha || last.ci_run_id !== pending.ci_run_id ||
    last.ci_run_attempt !== pending.ci_run_attempt || last.before_sha256 !== pending.before_sha256 ||
    last.after_sha256 !== pending.after_sha256
  ) refuse("last_record_pending_mismatch");
  const protection = parseProtection(paths, options);
  const assetDigests = options.protectedAssetDigests();
  if (
    protection === null || protection.version !== 2 || protection.candidate_sha !== pending.candidate_sha ||
    JSON.stringify(protection.assets) !== JSON.stringify(assetDigests)
  ) refuse("protection_record_pending_mismatch");
  return {
    status: "awaiting_provider_revocation",
    candidateSha: pending.candidate_sha,
    runId: pending.ci_run_id,
    runAttempt: pending.ci_run_attempt,
    transactionId: pending.transaction_id,
    precheckSha256: pending.precheck_sha256,
  };
}

function recordMatchesLiveFinalizer(record, expected) {
  return record.transaction_id === expected.transactionId &&
    record.precheck_sha256 === expected.precheckSha256 &&
    record.candidate_sha === expected.sha &&
    record.ci_run_id === expected.runId &&
    record.ci_run_attempt === expected.runAttempt &&
    record.before_sha256 === expected.beforeSha256 &&
    record.after_sha256 === expected.afterSha256;
}

export function finalizeCredentialTransitionLive({
  sha,
  runId,
  runAttempt,
  transactionId,
  precheckSha256,
  beforeSha256,
  afterSha256,
  awaitingLastSha256,
  completionSha256,
  paths = PRODUCTION_PATHS,
  ...overrides
}) {
  const expected = {
    sha,
    runId,
    runAttempt: Number(runAttempt),
    transactionId,
    precheckSha256,
    beforeSha256,
    afterSha256,
  };
  if (
    !SHA_PATTERN.test(sha) ||
    !RUN_PATTERN.test(runId) ||
    !RUN_ATTEMPT_PATTERN.test(String(runAttempt)) ||
    !TRANSACTION_ID_PATTERN.test(transactionId) ||
    !DIGEST_PATTERN.test(precheckSha256) ||
    !DIGEST_PATTERN.test(beforeSha256) ||
    !DIGEST_PATTERN.test(afterSha256) ||
    beforeSha256 === afterSha256 ||
    !DIGEST_PATTERN.test(awaitingLastSha256) ||
    !DIGEST_PATTERN.test(completionSha256)
  ) refuse("arguments_invalid");

  const options = normalizedOptions(overrides);
  const inboxQuarantine = `${paths.inbox}.live-finalize-consuming`;
  const backupQuarantine = `${paths.backup}.live-finalize-consuming`;
  const pendingQuarantine = `${paths.pending}.live-finalize-consuming`;
  validateStaticPaths(paths, options, false, [basename(inboxQuarantine)]);
  for (const conflicting of [
    paths.pendingNext,
    paths.backupPreparing,
    paths.runtimeNext,
    paths.protectionNext,
    paths.systemdPending,
    paths.credentialAssetsPending,
    paths.productionRollbackPending,
  ]) {
    if (pathEntryExists(conflicting)) refuse("live_finalizer_has_conflicting_artifact");
  }
  secureCleanup(paths.lastNext, paths.stateDir, "last_staging", options);

  const last = parseLast(paths, options);
  if (last === null || !recordMatchesLiveFinalizer(last, expected)) {
    refuse("live_finalizer_last_mismatch");
  }
  if (last.status === "awaiting_provider_revocation") {
    if (digest(readBounded(paths.last, 16_384, "last_record_invalid")) !== awaitingLastSha256) {
      refuse("live_finalizer_last_mismatch");
    }
  } else if (
    last.status !== "complete" ||
    last.awaiting_last_sha256 !== awaitingLastSha256 ||
    last.completion_sha256 !== completionSha256
  ) {
    refuse("live_finalizer_last_mismatch");
  }

  const runtime = readBounded(paths.runtime, 262_144, "runtime_invalid");
  if (digest(runtime) !== afterSha256) refuse("runtime_candidate_digest_mismatch");
  const protection = parseProtection(paths, options);
  const assetDigests = options.protectedAssetDigests();
  if (
    protection === null || protection.version !== 2 || protection.candidate_sha !== sha ||
    JSON.stringify(protection.assets) !== JSON.stringify(assetDigests)
  ) refuse("protection_record_pending_mismatch");

  const pendingSource = pathEntryExists(paths.pending) ? paths.pending : pendingQuarantine;
  const pending = pathEntryExists(pendingSource)
    ? parsePending({ ...paths, pending: pendingSource }, options)
    : null;
  if (pending !== null && (
    pending.phase !== "awaiting_provider_revocation" ||
    !recordMatchesLiveFinalizer(pending, expected)
  )) refuse("live_finalizer_pending_mismatch");
  if (last.status === "awaiting_provider_revocation" && pending === null) {
    refuse("live_finalizer_pending_missing");
  }

  let backup = null;
  const backupSource = pathEntryExists(paths.backup) ? paths.backup : backupQuarantine;
  if (pathEntryExists(backupSource)) {
    requireNode(backupSource, { kind: "file", modes: [0o600], label: "backup" }, options);
    backup = readBounded(backupSource, 262_144, "backup_invalid");
    if (digest(backup) !== beforeSha256) refuse("backup_digest_mismatch");
  } else if (last.status === "awaiting_provider_revocation") {
    refuse("backup_missing");
  }

  const inboxSource = pathEntryExists(paths.inbox) ? paths.inbox : inboxQuarantine;
  let inbox = null;
  if (pathEntryExists(inboxSource)) {
    if (backup === null) refuse("live_finalizer_backup_missing_for_inbox");
    inbox = parseInbox({ ...paths, inbox: inboxSource }, options);
    if (digest(renderRuntime(backup, inbox.assignment)) !== afterSha256) {
      refuse("inbox_candidate_digest_mismatch");
    }
  } else if (last.status === "awaiting_provider_revocation") {
    refuse("inbox_missing");
  }

  if (last.status === "awaiting_provider_revocation") {
    writeLiveCompleteLast(last, { awaitingLastSha256, completionSha256 }, paths, options);
    options.checkpoint("after_live_complete_record");
  }

  if (pathEntryExists(paths.inbox) || pathEntryExists(inboxQuarantine)) {
    removeExpectedDurably(paths.inbox, paths.inboxDir, inboxQuarantine, {
      label: "inbox",
      maximum: 4096,
      modes: [0o400, 0o600],
      validate(value) {
        if (inbox === null || value !== inbox.content) refuse("inbox_candidate_digest_mismatch");
      },
    }, options);
    options.checkpoint("after_live_inbox_removed");
  }
  if (pathEntryExists(paths.backup) || pathEntryExists(backupQuarantine)) {
    removeExpectedDurably(paths.backup, paths.stateDir, backupQuarantine, {
      label: "backup",
      maximum: 262_144,
      modes: [0o600],
      validate(value) {
        if (digest(value) !== beforeSha256) refuse("backup_digest_mismatch");
      },
    }, options);
    options.checkpoint("after_live_backup_removed");
  }
  if (pathEntryExists(paths.pending) || pathEntryExists(pendingQuarantine)) {
    removeExpectedDurably(paths.pending, paths.stateDir, pendingQuarantine, {
      label: "pending",
      maximum: 16_384,
      modes: [0o600],
      validate(value) {
        if (pending === null || value !== pendingPayload(pending)) refuse("live_finalizer_pending_mismatch");
      },
    }, options);
    options.checkpoint("after_live_pending_removed");
  }
  cleanupUncommittedFiles(paths, options);
  return { status: "complete" };
}

function requireCoordinatorLock() {
  let target;
  try {
    target = readlinkSync("/proc/self/fd/9");
  } catch {
    refuse("coordinator_lock_descriptor_missing");
  }
  if (target !== PRODUCTION_LOCK) refuse("coordinator_lock_descriptor_invalid");
  const stdio = Array(10).fill("ignore");
  stdio[9] = 9;
  runSilently("/usr/bin/flock", ["-n", "9"], { stdio });
}

function requireRoot() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    refuse("root_required");
  }
}

async function main(argv) {
  requireRoot();
  requireCoordinatorLock();
  if (argv[0] === "apply" && argv.length === 8) {
    const result = applyCredentialTransition({
      sha: argv[1],
      runId: argv[2],
      runAttempt: argv[3],
      transactionId: argv[4],
      precheckSha256: argv[5],
      transitionBeforeSha256: argv[6],
      transitionAfterSha256: argv[7],
    });
    process.stdout.write(`credential_transition=${result.status}\n`);
    return 0;
  }
  if (argv[0] === "adopt" && argv.length === 2) {
    const result = adoptServiceKeyStore({ sha: argv[1] });
    process.stdout.write(`credential_adopt=${result.status}\n`);
    return 0;
  }
  if (argv[0] === "adopt-recover" && argv.length === 1) {
    const result = recoverServiceKeyAdoption();
    process.stdout.write(`credential_adopt=${result.status}\n`);
    return 0;
  }
  if (argv[0] === "recover" && argv.length === 1) {
    const result = recoverCredentialTransition();
    process.stdout.write(`credential_transition=${result.status}\n`);
    return 0;
  }
  if (argv[0] === "inspect-awaiting" && argv.length === 1) {
    const result = inspectCredentialAwaitingState();
    process.stdout.write(`credential_transition=${result.status}\n`);
    return 0;
  }
  if (argv[0] === "finalize-live" && argv.length === 10) {
    const result = finalizeCredentialTransitionLive({
      sha: argv[1],
      runId: argv[2],
      runAttempt: argv[3],
      transactionId: argv[4],
      precheckSha256: argv[5],
      beforeSha256: argv[6],
      afterSha256: argv[7],
      awaitingLastSha256: argv[8],
      completionSha256: argv[9],
    });
    process.stdout.write(`credential_transition=${result.status}\n`);
    return 0;
  }
  if (argv[0] === "refresh-protection" && argv.length === 2) {
    const result = refreshCredentialProtection({ sha: argv[1] });
    process.stdout.write(`credential_protection=${result.status}\n`);
    return 0;
  }
  refuse("usage_invalid");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof TransitionError ? error.code : "unexpected_failure";
    process.stderr.write(`credential transition failed: ${code}\n`);
    process.exitCode = 1;
  });
}
