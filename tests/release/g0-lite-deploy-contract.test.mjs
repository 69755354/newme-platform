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
  for (const field of [
    "GIT_SHA",
    "BUILD_ID",
    "CI_RUN_ID",
    "CI_RUN_URL",
    "CI_HEAD_SHA",
    "CI_CONCLUSION",
    "MIGRATION_STATUS",
    "MIGRATION_IDS",
    "UAT_STATUS",
    "ROLLBACK_GIT_SHA",
  ]) {
    assert.match(deploy, new RegExp(`"${field}"\\s*:\\s*"\\$${${field}}`), `missing evidence field ${field}`);
  }
  assert.match(deploy, /BUILD_ID="\$NEW_BUILD_ID"/);
  assert.doesNotMatch(deploy, /(?:demo|fake)[_-]?(?:ci|sha|build|migration|uat)/i);
});
