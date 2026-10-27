#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFileSafely(filePath, label, maximumBytes = 64 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    fail(`${label} could not be opened without following a symlink (${error.code ?? "open_failed"})`);
  }
  let bytes;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} must be a regular non-symlink file`);
    if (before.size <= 0 || before.size > maximumBytes) fail(`${label} size is outside the accepted range`);
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.length !== before.size) {
      fail(`${label} changed while it was being read`);
    }
  } finally {
    closeSync(descriptor);
  }
  return bytes;
}

function readJsonFile(filePath, label) {
  const bytes = readFileSafely(filePath, label);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} root must be an object`);
  return { bytes, value };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} contains unknown property ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.deploy-acceptance-${process.pid}-${Date.now()}`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function recordDeployAcceptance({ evidencePath, attestationPath, bundlePath }) {
  const evidenceFile = readJsonFile(evidencePath, "deployment evidence");
  const attestationFile = readJsonFile(attestationPath, "postdeploy attestation");
  const bundleFile = readJsonFile(bundlePath, "sealed postdeploy bundle");
  const evidence = evidenceFile.value;
  const attestation = attestationFile.value;

  exactKeys(attestation, [
    "attestation_version",
    "schema_version",
    "release_sha",
    "build_id",
    "deploy_run_id",
    "bundle_sha256",
    "policy_sha256",
    "schema_sha256",
    "receipt_key_sha256",
    "sealed_artifacts",
    "verified_at",
  ], "postdeploy attestation");
  if (attestation.attestation_version !== "newme-postdeploy-attestation/v1") fail("attestation version is not supported");
  if (attestation.schema_version !== "newme-postdeploy-evidence/v1") fail("attestation schema version is not supported");
  for (const field of ["bundle_sha256", "policy_sha256", "schema_sha256", "receipt_key_sha256"]) {
    if (typeof attestation[field] !== "string" || !SHA256.test(attestation[field])) fail(`attestation.${field} is invalid`);
  }
  if (sha256(bundleFile.bytes) !== attestation.bundle_sha256) fail("sealed bundle digest does not match attestation");
  if (bundleFile.value.receipt_key_sha256 !== attestation.receipt_key_sha256) {
    fail("sealed bundle receipt key digest does not match attestation");
  }
  if (
    evidence.git_sha !== attestation.release_sha
    || evidence.build_id !== attestation.build_id
    || String(evidence.ci?.run_id ?? "") !== attestation.deploy_run_id
    || evidence.created_at !== bundleFile.value?.release?.deployed_at
  ) {
    fail("attestation is not bound to deployment evidence release/build/run/time");
  }
  const bundleArtifacts = bundleFile.value.artifacts;
  if (!Array.isArray(bundleArtifacts) || bundleArtifacts.length === 0) fail("sealed bundle has no artifact manifest");
  const bundleArtifactsById = new Map();
  for (const [index, artifact] of bundleArtifacts.entries()) {
    exactKeys(artifact, ["id", "kind", "path", "sha256", "media_type"], `sealed bundle artifact ${index}`);
    if (
      typeof artifact.id !== "string"
      || bundleArtifactsById.has(artifact.id)
      || typeof artifact.sha256 !== "string"
      || !SHA256.test(artifact.sha256)
      || artifact.media_type !== "application/json"
    ) fail(`sealed bundle artifact ${index} identity is invalid`);
    bundleArtifactsById.set(artifact.id, artifact);
  }
  if (!Array.isArray(attestation.sealed_artifacts) || attestation.sealed_artifacts.length !== bundleArtifactsById.size) {
    fail("attestation sealed artifact inventory does not match the bundle");
  }
  const sealedIds = new Set();
  for (const [index, artifact] of attestation.sealed_artifacts.entries()) {
    exactKeys(artifact, ["id", "sha256", "file"], `attestation sealed artifact ${index}`);
    const bundleArtifact = bundleArtifactsById.get(artifact.id);
    if (
      sealedIds.has(artifact.id)
      || !bundleArtifact
      || artifact.sha256 !== bundleArtifact.sha256
      || artifact.file !== `artifacts/${artifact.sha256}`
    ) fail(`attestation sealed artifact ${index} does not match the bundle`);
    const artifactPath = path.join(path.dirname(attestationPath), ...artifact.file.split("/"));
    if (sha256(readFileSafely(artifactPath, `sealed artifact ${index}`)) !== artifact.sha256) {
      fail(`sealed artifact ${index} digest does not match the attestation`);
    }
    sealedIds.add(artifact.id);
  }

  const expectedAcceptance = {
    status: "verified",
    attestation_version: attestation.attestation_version,
    schema_version: attestation.schema_version,
    bundle_sha256: attestation.bundle_sha256,
    policy_sha256: attestation.policy_sha256,
    schema_sha256: attestation.schema_sha256,
    receipt_key_sha256: attestation.receipt_key_sha256,
    deploy_run_id: attestation.deploy_run_id,
    sealed_directory: "postdeploy-acceptance-v1",
    verified_at: attestation.verified_at,
  };

  if (evidence.release_status === "acceptance_verified") {
    if (JSON.stringify(evidence.acceptance) !== JSON.stringify(expectedAcceptance)) {
      fail("existing acceptance_verified evidence does not match sealed attestation");
    }
    return expectedAcceptance;
  }
  if (evidence.release_status !== "awaiting_uat") {
    fail("deployment evidence must be awaiting_uat before attestation");
  }
  if (Object.hasOwn(evidence, "acceptance")) fail("awaiting_uat evidence already contains an acceptance claim");

  evidence.acceptance = expectedAcceptance;
  evidence.release_status = "acceptance_verified";
  writeAtomic(evidencePath, evidence);
  return expectedAcceptance;
}

function parseArgs(argv) {
  const allowed = new Set(["--evidence", "--attestation", "--bundle"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail(`unknown argument ${JSON.stringify(flag)}`);
    if (values.has(flag)) fail(`argument ${flag} was provided more than once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`argument ${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of allowed) if (!values.has(flag)) fail(`missing required argument ${flag}`);
  return values;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const values = parseArgs(argv);
    const acceptance = recordDeployAcceptance({
      evidencePath: path.resolve(values.get("--evidence")),
      attestationPath: path.resolve(values.get("--attestation")),
      bundlePath: path.resolve(values.get("--bundle")),
    });
    process.stdout.write(`POSTDEPLOY_ACCEPTANCE_DIGEST=${acceptance.bundle_sha256}\n`);
    return 0;
  } catch (error) {
    console.error(`deploy acceptance: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
