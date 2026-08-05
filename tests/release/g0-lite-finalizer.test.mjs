import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    rollback: { git_sha: "b".repeat(40), build_id: "build-old", backup_dir: ".next.backup.1" },
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
  return spawnSync("bash", ["scripts/finalize-deploy-evidence.sh", path], {
    encoding: "utf8",
    env: {
      ...process.env,
      UAT_STATUS: "pass",
      UAT_ACTOR: "Codex authenticated session",
      UAT_FIXTURE_IDS: "",
      FIXTURE_CLEANUP_STATUS: "not_required",
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
  assert.notEqual(result.status, 0);
  assert.equal((await evidence(path)).release_status, "uat_failed");
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
  assert.equal(resultEvidence.release_status, "complete");
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
