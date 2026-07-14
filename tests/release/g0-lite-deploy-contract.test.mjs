import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const deployPath = join(repoRoot, "scripts", "deploy.sh");
const deploy = await readFile(deployPath, "utf8");

function executableIndex(pattern) {
  return deploy
    .split("\n")
    .findIndex((line) => !line.trimStart().startsWith("#") && pattern.test(line));
}

test("release preflight runs before service, migration, typecheck, or build mutations", () => {
  const preflight = executableIndex(/bash scripts\/verify-release-preflight\.sh/);
  assert.notEqual(preflight, -1, "deploy must invoke verify-release-preflight.sh");

  for (const [name, pattern] of [
    ["systemctl", /systemctl/],
    ["migration", /\bmigrat(?:e|ion)\b/i],
    ["typecheck", /npx tsc/],
    ["dependency install", /npm ci/],
    ["build", /npm run build/],
  ]) {
    const gate = executableIndex(pattern);
    if (gate !== -1) {
      assert.ok(preflight < gate, `preflight must run before ${name}`);
    }
  }
});

test("build is sourced from a detached worktree pinned to the verified release SHA", () => {
  assert.match(deploy, /RELEASE_SHA=.*verify-release-preflight\.sh/);
  assert.match(deploy, /git\s+-C\s+"\$PROJECT_ROOT"\s+worktree\s+add\s+--detach\s+"\$BUILD_DIR"\s+"\$RELEASE_SHA"/);
  assert.doesNotMatch(deploy, /^\s*rsync\b/m);
});

test("exit cleanup removes and prunes the detached build worktree", () => {
  assert.match(deploy, /git\s+-C\s+"\$PROJECT_ROOT"\s+worktree\s+remove\s+--force\s+"\$BUILD_DIR"/);
  assert.match(deploy, /git\s+-C\s+"\$PROJECT_ROOT"\s+worktree\s+prune/);
});

test("deploy evidence records release identity, CI, migration, UAT, and rollback fields", () => {
  for (const token of [
    '"git_sha": "$GIT_SHA"',
    '"build_id": "$BUILD_ID"',
    '"run_id": "$CI_RUN_ID"',
    '"run_url": "$CI_RUN_URL"',
    '"head_sha": "$CI_HEAD_SHA"',
    '"conclusion": "$CI_CONCLUSION"',
    '"status": "$MIGRATION_STATUS"',
    '"ids": "$MIGRATION_IDS"',
    '"git_sha": "$ROLLBACK_GIT_SHA"',
    '"release_status": "$EVI_RELEASE_STATUS"',
  ]) {
    assert.ok(deploy.includes(token), `missing evidence token: ${token}`);
  }
  assert.match(deploy, /BUILD_ID="\$NEW_BUILD_ID"/);
  assert.match(deploy, /EVI_RELEASE_STATUS="awaiting_uat"/);
  assert.doesNotMatch(deploy, /"release_status":\s*"complete"/);
  assert.doesNotMatch(deploy, /(?:demo|fake)[_-]?(?:ci|sha|build|migration|uat)/i);
});

test("expired authorization fails without rewriting a manifest", () => {
  assert.doesNotMatch(deploy, /json\.dump\(obj,\s*open\(p,\s*['"]w['"]\)/);
  assert.doesNotMatch(deploy, /Manifest refreshed/);
});

test("legacy Hermes authorization gates are not part of deployment", () => {
  assert.doesNotMatch(deploy, /verify-coding-auth\.py/);
  assert.doesNotMatch(deploy, /\.hermes\/delegations/);
  assert.doesNotMatch(deploy, /CONTROL_PLANE_AUTH/);
});
