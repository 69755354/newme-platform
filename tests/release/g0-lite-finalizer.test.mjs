import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLOSURE_SHA = "c".repeat(40);
const FINAL_RUN_ID = "29351813434";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "newme-evidence-"));
  const path = join(directory, "deploy.json");
  const gitSha = "a".repeat(40);
  await writeFile(path, JSON.stringify({
    git_sha: gitSha,
    build_id: "build-new",
    ci: { run_id: "123", run_url: "https://github.com/69755354/newme-platform/actions/runs/123", head_sha: gitSha, conclusion: "success" },
    migration: { status: "not_required", ids: "" },
    uat: { status: "pending", actor: "", completed_at: "", fixture_ids: [], cleanup_status: "pending" },
    rollback: {
      git_sha: "b".repeat(40),
      build_id: "build-old",
      backup_dir: ".next.backup.1",
      asset_backup: "/var/backups/newme-systemd-assets/test-fixture",
    },
    build: { status: "pass" },
    systemd: { status: "pass" },
    smoke: { status: "pass" },
    logs: { status: "pass" },
    regression: { status: "pass" },
    health: { status: "pass" },
    release_status: "awaiting_uat",
  }, null, 2) + "\n");
  return path;
}

function finalize(path, overrides = {}) {
  return spawnSync(process.execPath, ["scripts/run-bash.mjs", "scripts/finalize-deploy-evidence.sh", path], {
    encoding: "utf8",
    env: {
      ...process.env,
      UAT_STATUS: "pass",
      UAT_ACTOR: "Codex authenticated session",
      UAT_FIXTURE_IDS: "",
      FIXTURE_CLEANUP_STATUS: "not_required",
      RELEASE_CLOSURE_SHA: CLOSURE_SHA,
      RELEASE_FINAL_RUN_ID: FINAL_RUN_ID,
      ...overrides,
    },
  });
}

async function evidence(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("missing authenticated actor cannot complete release", async () => {
  const path = await fixture();
  const result = finalize(path, { UAT_ACTOR: "" });
  assert.notEqual(result.status, 0);
  assert.equal((await evidence(path)).release_status, "awaiting_uat");
});

test("failed UAT is recorded and leaves release incomplete", async () => {
  const path = await fixture();
  const result = finalize(path, { UAT_STATUS: "fail" });
  assert.equal(result.status, 0, result.stderr);
  const resultEvidence = await evidence(path);
  assert.equal(resultEvidence.release_status, "uat_failed");
  assert.equal(resultEvidence.release_closure, undefined);
});

test("matching failed UAT retry is idempotent and cannot be promoted", async () => {
  const path = await fixture();
  const overrides = { UAT_STATUS: "fail" };
  const first = finalize(path, overrides);
  assert.equal(first.status, 0, first.stderr);
  const failed = await evidence(path);

  const retry = finalize(path, overrides);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(await evidence(path), failed);

  const promote = finalize(path, { UAT_STATUS: "pass" });
  assert.notEqual(promote.status, 0);
  assert.deepEqual(await evidence(path), failed);
});

test("fixture IDs reject unverified cleanup", async () => {
  const path = await fixture();
  const result = finalize(path, {
    UAT_FIXTURE_IDS: "fixture-1",
    FIXTURE_CLEANUP_STATUS: "not_required",
  });
  assert.notEqual(result.status, 0);
  assert.equal((await evidence(path)).release_status, "awaiting_uat");
});

test("passing authenticated UAT with exact cleanup completes release", async () => {
  const path = await fixture();
  const result = finalize(path, {
    UAT_FIXTURE_IDS: "fixture-1,fixture-2",
    FIXTURE_CLEANUP_STATUS: "archived_verified",
  });
  assert.equal(result.status, 0, result.stderr);
  const resultEvidence = await evidence(path);
  assert.deepEqual(resultEvidence.uat.fixture_ids, ["fixture-1", "fixture-2"]);
  assert.deepEqual(resultEvidence.release_closure, {
    release_sha: "a".repeat(40),
    closure_sha: CLOSURE_SHA,
    final_ci_run_id: FINAL_RUN_ID,
    final_ci_run_url: `https://github.com/69755354/newme-platform/actions/runs/${FINAL_RUN_ID}`,
    final_ci_head_sha: CLOSURE_SHA,
    final_ci_conclusion: "success",
    required_jobs_manifest: "infra/release/final-required-jobs.json",
    verified_at: resultEvidence.uat.completed_at,
  });
  assert.equal(resultEvidence.release_status, "complete");
});

test("passing UAT cannot complete without an exact closure SHA and final run", async () => {
  for (const overrides of [
    { RELEASE_CLOSURE_SHA: "" },
    { RELEASE_CLOSURE_SHA: "c".repeat(39) },
    { RELEASE_CLOSURE_SHA: "a".repeat(40) },
    { RELEASE_FINAL_RUN_ID: "" },
    { RELEASE_FINAL_RUN_ID: "manual" },
  ]) {
    const path = await fixture();
    const result = finalize(path, overrides);
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.equal((await evidence(path)).release_status, "awaiting_uat");
  }
});

test("physically removed synthetic fixtures are recorded truthfully", async () => {
  const path = await fixture();
  const result = finalize(path, {
    UAT_FIXTURE_IDS: "fixture-1,fixture-2",
    FIXTURE_CLEANUP_STATUS: "removed_verified",
  });
  assert.equal(result.status, 0, result.stderr);
  const resultEvidence = await evidence(path);
  assert.equal(resultEvidence.uat.cleanup_status, "removed_verified");
  assert.equal(resultEvidence.release_status, "complete");
});

test("no-fixture UAT accepts not_required cleanup", async () => {
  const path = await fixture();
  const result = finalize(path);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await evidence(path)).uat.fixture_ids, []);
});

test("matching completion retry is idempotent and a mismatched retry fails closed", async () => {
  const path = await fixture();
  const overrides = {
    UAT_FIXTURE_IDS: "fixture-1",
    FIXTURE_CLEANUP_STATUS: "removed_verified",
  };
  const first = finalize(path, overrides);
  assert.equal(first.status, 0, first.stderr);
  const completed = await evidence(path);

  const retry = finalize(path, overrides);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(await evidence(path), completed);

  const mismatch = finalize(path, { ...overrides, UAT_ACTOR: "different actor" });
  assert.notEqual(mismatch.status, 0);
  assert.deepEqual(await evidence(path), completed);

  const wrongClosure = finalize(path, { ...overrides, RELEASE_CLOSURE_SHA: "d".repeat(40) });
  assert.notEqual(wrongClosure.status, 0);
  assert.deepEqual(await evidence(path), completed);

  const wrongRun = finalize(path, { ...overrides, RELEASE_FINAL_RUN_ID: "29351813435" });
  assert.notEqual(wrongRun.status, 0);
  assert.deepEqual(await evidence(path), completed);
});
