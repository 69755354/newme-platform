import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const preflight = join(repoRoot, "scripts", "verify-release-preflight.sh");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "newme-preflight-"));
  const origin = join(directory, "origin.git");
  const seed = join(directory, "seed");
  const checkout = join(directory, "checkout");

  git(directory, "init", "--bare", "--initial-branch=main", origin);
  git(directory, "clone", origin, seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  await mkdir(join(seed, "scripts"));
  await writeFile(join(seed, "scripts", "verify-release-preflight.sh"), await readFile(preflight));
  await writeFile(join(seed, "tracked.txt"), "clean\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "fixture");
  git(seed, "push", "-u", "origin", "main");
  git(directory, "clone", origin, checkout);

  return {
    checkout,
    seed,
    releaseSha: git(checkout, "rev-parse", "HEAD"),
  };
}

function verify({ checkout, releaseSha }, overrides = {}) {
  const runId = "29351813434";
  return spawnSync("bash", ["scripts/verify-release-preflight.sh"], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      CI_RUN_ID: runId,
      CI_RUN_URL: `https://github.com/69755354/newme-platform/actions/runs/${runId}`,
      CI_HEAD_SHA: releaseSha,
      CI_CONCLUSION: "success",
      MIGRATION_STATUS: "not_required",
      MIGRATION_IDS: "",
      ROLLBACK_GIT_SHA: releaseSha,
      ...overrides,
    },
  });
}

function assertFails(result, reason) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, reason);
  assert.equal(result.stdout, "");
}

test("valid clean main at origin/main passes and prints the release SHA", async () => {
  const repo = await fixture();
  const result = verify(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${repo.releaseSha}\n`);
  assert.equal(result.stderr, "");
});

test("feature branch fails", async () => {
  const repo = await fixture();
  git(repo.checkout, "checkout", "-b", "feature");
  assertFails(verify(repo), /symbolic branch main/);
});

test("local main behind origin/main fails", async () => {
  const repo = await fixture();
  await writeFile(join(repo.seed, "tracked.txt"), "remote update\n");
  git(repo.seed, "add", "tracked.txt");
  git(repo.seed, "commit", "-m", "advance origin");
  git(repo.seed, "push", "origin", "main");
  assertFails(verify(repo), /HEAD must equal origin\/main/);
});

test("tracked dirt fails", async () => {
  const repo = await fixture();
  await writeFile(join(repo.checkout, "tracked.txt"), "dirty\n");
  assertFails(verify(repo), /worktree must be clean/);
});

test("staged dirt fails", async () => {
  const repo = await fixture();
  await writeFile(join(repo.checkout, "tracked.txt"), "staged\n");
  git(repo.checkout, "add", "tracked.txt");
  assertFails(verify(repo), /worktree must be clean/);
});

test("untracked dirt fails", async () => {
  const repo = await fixture();
  await writeFile(join(repo.checkout, "untracked.txt"), "dirty\n");
  assertFails(verify(repo), /worktree must be clean/);
});

test("missing CI run ID fails", async () => {
  const repo = await fixture();
  assertFails(verify(repo, { CI_RUN_ID: "" }), /CI_RUN_ID is required/);
});

test("failed CI conclusion fails", async () => {
  const repo = await fixture();
  assertFails(verify(repo, { CI_CONCLUSION: "failure" }), /CI_CONCLUSION must be success/);
});

test("CI SHA mismatch fails", async () => {
  const repo = await fixture();
  assertFails(verify(repo, { CI_HEAD_SHA: "f".repeat(40) }), /CI_HEAD_SHA must equal release SHA/);
});

test("CI URL on another domain fails", async () => {
  const repo = await fixture();
  assertFails(
    verify(repo, { CI_RUN_URL: "https://example.com/actions/runs/29351813434" }),
    /CI_RUN_URL must equal expected GitHub Actions run URL/,
  );
});

test("applied migration without IDs fails", async () => {
  const repo = await fixture();
  assertFails(
    verify(repo, { MIGRATION_STATUS: "applied_verified", MIGRATION_IDS: "" }),
    /MIGRATION_IDS is required for applied_verified/,
  );
});

test("rollback SHA that does not resolve fails", async () => {
  const repo = await fixture();
  assertFails(
    verify(repo, { ROLLBACK_GIT_SHA: "f".repeat(40) }),
    /ROLLBACK_GIT_SHA must resolve to a commit/,
  );
});
