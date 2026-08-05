import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const deploy = await readFile(join(repoRoot, "scripts", "deploy-immutable.sh"), "utf8");

function executableIndex(pattern) {
  return deploy.split("\n").findIndex((line) => !line.trimStart().startsWith("#") && pattern.test(line));
}

test("release preflight runs before build or service mutations", () => {
  const preflight = executableIndex(/verify-release-preflight\.sh/);
  assert.notEqual(preflight, -1, "deploy must invoke verify-release-preflight.sh");
  for (const [name, pattern] of [["dependency install", /npm ci/], ["build", /npm run build/], ["service", /\$CONTROL.*restart/]]) {
    const mutation = executableIndex(pattern);
    assert.notEqual(mutation, -1, `deploy must contain ${name}`);
    assert.ok(preflight < mutation, `preflight must run before ${name}`);
  }
});

test("build is sourced from the exact verified release SHA", () => {
  assert.match(deploy, /\[\[ "\$SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(deploy, /git -C "\$ROOT" archive "\$SHA"/);
  assert.match(deploy, /npm ci --no-audit --no-fund/);
  assert.doesNotMatch(deploy, /^\s*rsync\b/m);
});

test("exit cleanup contains the candidate and incomplete release", () => {
  assert.match(deploy, /kill -TERM -- "-\$PGID"/);
  assert.match(deploy, /rm -rf -- "\$STAGE"/);
  assert.match(deploy, /CREATED_RELEASE/);
  assert.doesNotMatch(deploy, /(?:fuser\s+-k|pkill)/);
});

test("deploy evidence remains bound to CI, migration, UAT, and rollback", () => {
  for (const token of ["CI_RUN_ID", "CI_RUN_URL", "CI_HEAD_SHA", "CI_CONCLUSION", "MIGRATION_STATUS", "MIGRATION_IDS", "ROLLBACK_GIT_SHA", '"release_status": "awaiting_uat"']) {
    assert.ok(deploy.includes(token), `missing evidence token: ${token}`);
  }
  assert.match(deploy, /finalize-deploy-evidence|status=awaiting_uat/);
  assert.doesNotMatch(deploy, /"release_status":\s*"complete"/);
  assert.doesNotMatch(deploy, /(?:demo|fake)[_-]?(?:ci|sha|build|migration|uat)/i);
});

test("deployment evidence defaults to the immutable release instead of the temporary worktree", () => {
  assert.match(deploy, /EVIDENCE_DIR="\$TARGET\/\.audit"/);
  assert.doesNotMatch(deploy, /NEWME_EVIDENCE_DIR:-\$ROOT\/\.audit/);
  assert.ok(deploy.indexOf('EVIDENCE_DIR="$TARGET/.audit"') < deploy.indexOf('python3 - "$EVIDENCE_FILE"'));
});

test("legacy Hermes authorization gates are not part of deployment", () => {
  assert.doesNotMatch(deploy, /verify-coding-auth\.py|\.hermes\/delegations|CONTROL_PLANE_AUTH/);
});

test("release shell scripts have valid Bash syntax", () => {
  for (const script of ["scripts/verify-release-preflight.sh", "scripts/deploy.sh", "scripts/deploy-immutable.sh", "scripts/install-systemd-assets.sh", "scripts/rollback-systemd-assets.sh", "scripts/finalize-deploy-evidence.sh"]) {
    const result = spawnSync("bash", ["-n", script], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});
