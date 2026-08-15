import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLOSURE_SHA = "c".repeat(40);
const FINAL_RUN_ID = "29351813434";
const RELEASE_SHA = "a".repeat(40);
const BUILD_ID = "build-new";
const DEPLOY_RUN_ID = "123";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture({ status = "acceptance_verified" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "newme-evidence-"));
  const path = join(directory, "deploy.json");
  const sealed = join(directory, "postdeploy-acceptance-v1");
  const artifacts = join(sealed, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const artifactBytes = Buffer.from('{"artifact_version":"newme-postdeploy-artifact/v1","kind":"role_uat"}\n');
  const artifactDigest = digest(artifactBytes);
  const bundleBytes = Buffer.from(`${JSON.stringify({
    schema_version: "newme-postdeploy-evidence/v1",
    policy: { sha256: "d".repeat(64) },
    schema: { sha256: "e".repeat(64) },
    receipt_key_sha256: "f".repeat(64),
    release: { git_sha: RELEASE_SHA, build_id: BUILD_ID, deploy_run_id: DEPLOY_RUN_ID },
    artifacts: [{
      id: "proof",
      kind: "role_uat",
      path: "proof.json",
      sha256: artifactDigest,
      media_type: "application/json",
    }],
  }, null, 2)}\n`);
  const bundleDigest = digest(bundleBytes);
  await writeFile(join(sealed, "bundle.json"), bundleBytes);
  await writeFile(join(artifacts, artifactDigest), artifactBytes);
  const attestation = {
    attestation_version: "newme-postdeploy-attestation/v1",
    schema_version: "newme-postdeploy-evidence/v1",
    release_sha: RELEASE_SHA,
    build_id: BUILD_ID,
    deploy_run_id: DEPLOY_RUN_ID,
    bundle_sha256: bundleDigest,
    policy_sha256: "d".repeat(64),
    schema_sha256: "e".repeat(64),
    receipt_key_sha256: "f".repeat(64),
    sealed_artifacts: [{ id: "proof", sha256: artifactDigest, file: `artifacts/${artifactDigest}` }],
    verified_at: "2026-08-15T00:20:00Z",
  };
  await writeFile(join(sealed, "attestation.json"), `${JSON.stringify(attestation, null, 2)}\n`);
  const acceptance = {
    status: "verified",
    attestation_version: attestation.attestation_version,
    schema_version: attestation.schema_version,
    bundle_sha256: bundleDigest,
    policy_sha256: attestation.policy_sha256,
    schema_sha256: attestation.schema_sha256,
    receipt_key_sha256: attestation.receipt_key_sha256,
    deploy_run_id: DEPLOY_RUN_ID,
    sealed_directory: "postdeploy-acceptance-v1",
    verified_at: attestation.verified_at,
  };
  await writeFile(path, `${JSON.stringify({
    git_sha: RELEASE_SHA,
    build_id: BUILD_ID,
    ci: {
      run_id: DEPLOY_RUN_ID,
      run_url: `https://github.com/69755354/newme-platform/actions/runs/${DEPLOY_RUN_ID}`,
      head_sha: RELEASE_SHA,
      conclusion: "success",
    },
    migration: { status: "not_required", ids: [] },
    rollback: {
      git_sha: "b".repeat(40),
      build_id: "build-old",
      backup_dir: "/opt/newme/releases/" + "b".repeat(40),
      asset_backup: "/var/backups/newme-systemd-assets/test-fixture",
    },
    build: { status: "pass" },
    systemd: { status: "pass" },
    smoke: { status: "pass" },
    logs: { status: "pass" },
    regression: { status: "pass" },
    health: { status: "pass" },
    ...(status === "acceptance_verified" ? { acceptance } : {}),
    release_status: status,
  }, null, 2)}\n`);
  return { path, directory, sealed, bundleDigest, artifactDigest };
}

function finalize(path, acceptanceDigest, closureSha = CLOSURE_SHA, finalRunId = FINAL_RUN_ID) {
  return spawnSync(process.execPath, [
    "scripts/run-bash.mjs",
    "scripts/finalize-deploy-evidence.sh",
    path,
    acceptanceDigest,
    closureSha,
    finalRunId,
  ], { encoding: "utf8" });
}

async function evidence(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("awaiting_uat self-report cannot complete a release", async () => {
  const fx = await fixture({ status: "awaiting_uat" });
  const result = finalize(fx.path, fx.bundleDigest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /acceptance_verified/);
  assert.equal((await evidence(fx.path)).release_status, "awaiting_uat");
});

test("acceptance_verified plus the matching sealed digest completes release", async () => {
  const fx = await fixture();
  const result = finalize(fx.path, fx.bundleDigest);
  assert.equal(result.status, 0, result.stderr);
  const completed = await evidence(fx.path);
  assert.equal(completed.release_status, "complete");
  assert.equal(completed.release_closure.acceptance_digest, fx.bundleDigest);
  assert.equal(completed.release_closure.release_sha, RELEASE_SHA);
  assert.equal(completed.release_closure.closure_sha, CLOSURE_SHA);
  assert.equal(completed.release_closure.final_ci_run_id, FINAL_RUN_ID);
});

test("wrong acceptance digest, closure SHA, and final run fail closed", async () => {
  for (const [digestValue, closure, run] of [
    ["f".repeat(64), CLOSURE_SHA, FINAL_RUN_ID],
    ["bad", CLOSURE_SHA, FINAL_RUN_ID],
    [null, "short", FINAL_RUN_ID],
    [null, RELEASE_SHA, FINAL_RUN_ID],
    [null, CLOSURE_SHA, "manual"],
  ]) {
    const fx = await fixture();
    const result = finalize(fx.path, digestValue ?? fx.bundleDigest, closure, run);
    assert.notEqual(result.status, 0, JSON.stringify({ digestValue, closure, run }));
    assert.equal((await evidence(fx.path)).release_status, "acceptance_verified");
  }
});

test("tampered sealed bundle or artifact cannot complete", async () => {
  const bundleFx = await fixture();
  await writeFile(join(bundleFx.sealed, "bundle.json"), "{}\n");
  const badBundle = finalize(bundleFx.path, bundleFx.bundleDigest);
  assert.notEqual(badBundle.status, 0);
  assert.match(badBundle.stderr, /sealed bundle digest/);

  const artifactFx = await fixture();
  await writeFile(join(artifactFx.sealed, "artifacts", artifactFx.artifactDigest), "tampered\n");
  const badArtifact = finalize(artifactFx.path, artifactFx.bundleDigest);
  assert.notEqual(badArtifact.status, 0);
  assert.match(badArtifact.stderr, /artifact 0 digest/);
});

test("restamping the bundle cannot detach its artifact manifest from sealed bytes", async () => {
  const fx = await fixture();
  const bundlePath = join(fx.sealed, "bundle.json");
  const attestationPath = join(fx.sealed, "attestation.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  bundle.artifacts[0].sha256 = "f".repeat(64);
  const bundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  const restampedDigest = digest(bundleBytes);
  await writeFile(bundlePath, bundleBytes);
  const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
  attestation.bundle_sha256 = restampedDigest;
  await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
  const deployEvidence = await evidence(fx.path);
  deployEvidence.acceptance.bundle_sha256 = restampedDigest;
  await writeFile(fx.path, `${JSON.stringify(deployEvidence, null, 2)}\n`);

  const result = finalize(fx.path, restampedDigest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the bundle artifact manifest/);
  assert.equal((await evidence(fx.path)).release_status, "acceptance_verified");
});

test("matching completion retry is idempotent and a mismatched retry is refused", async () => {
  const fx = await fixture();
  const first = finalize(fx.path, fx.bundleDigest);
  assert.equal(first.status, 0, first.stderr);
  const completed = await evidence(fx.path);
  const retry = finalize(fx.path, fx.bundleDigest);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(await evidence(fx.path), completed);

  const wrongClosure = finalize(fx.path, fx.bundleDigest, "d".repeat(40));
  assert.notEqual(wrongClosure.status, 0);
  assert.deepEqual(await evidence(fx.path), completed);
  const wrongRun = finalize(fx.path, fx.bundleDigest, CLOSURE_SHA, "29351813435");
  assert.notEqual(wrongRun.status, 0);
  assert.deepEqual(await evidence(fx.path), completed);
});

test("the removed freeform actor and fixture interface is not accepted", async () => {
  const fx = await fixture();
  const result = spawnSync(process.execPath, [
    "scripts/run-bash.mjs",
    "scripts/finalize-deploy-evidence.sh",
    fx.path,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      UAT_STATUS: "pass",
      UAT_ACTOR: "self-report",
      UAT_FIXTURE_IDS: "",
      FIXTURE_CLEANUP_STATUS: "not_required",
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal((await evidence(fx.path)).release_status, "acceptance_verified");
});
