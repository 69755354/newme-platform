import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (path) => readFile(join(repoRoot, path), "utf8");
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";
const run = (script, args) =>
  spawnSync(bash, [join(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });

test("service control fails closed on arity, direct actions, and unit-shaped reasons", () => {
  const cases = [
    [],
    ["restart"],
    ["restart", "reason", "extra"],
    ["start", "incident:recovery"],
    ["stop", "incident:recovery"],
    ["try-restart", "incident:recovery"],
    ["restart", "newme-platform.service"],
    ["restart", "probe.socket"],
    ["reset-failed", "nightly.timer"],
    ["restart", "multi-user.target"],
    ["restart", "opt-newme.mount"],
    ["restart", "watch.path"],
    ["restart", "workload.slice"],
  ];
  for (const args of cases) {
    const result = run("infra/systemd/newme-service-control.sh", args);
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
  }
});

test("service control statically binds exactly two arguments to one fixed unit", async () => {
  const control = await read("infra/systemd/newme-service-control.sh");
  assert.match(control, /\[ "\$#" -eq 2 \] \|\| usage/);
  assert.match(control, /exec \/usr\/bin\/systemctl "\$action" newme-platform\.service/);
  assert.doesNotMatch(control, /systemctl "\$action" "\$/);
});

test("rollback controller is single-purpose, atomic, locked, and self-restoring", async () => {
  const rollback = await read("infra/systemd/newme-release-rollback.sh");
  for (const pattern of [
    /\[ "\$#" -eq 1 \] \|\| usage/,
    /CURRENT=\/opt\/newme\/current/,
    /ROLLBACK=\/opt\/newme\/current\.rollback/,
    /flock -n 9/,
    /renameat2/,
    /RENAME_EXCHANGE = 2/,
    /restore_on_failure/,
    /rollback target failed; original release restored/,
    /curl -fsS --max-time 10 http:\/\/127\.0\.0\.1:3001\/api\/health/,
  ]) assert.match(rollback, pattern);
  assert.doesNotMatch(rollback, /\b(?:rm -rf|fuser|pkill|kill)\b/);

  for (const args of [[], ["reason", "extra"], ["newme-platform.service"]]) {
    const result = run("infra/systemd/newme-release-rollback.sh", args);
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
  }
});

test("guarded deploy requires exact successful main CI and exact incident assets", async () => {
  const deploy = await read("infra/systemd/newme-deploy.sh");
  for (const pattern of [
    /RUN_ID" =~ \^\[0-9\]\+\$/,
    /run\.get\("head_sha"\) != expected_sha/,
    /run\.get\("head_branch"\) != "main"/,
    /run\.get\("event"\) != "workflow_dispatch"/,
    /run\.get\("status"\) != "completed"/,
    /run\.get\("conclusion"\) != "success"/,
    /run\.get\("name"\) != "ci"/,
    /run\.get\("path"\) != "\.github\/workflows\/ci\.yml"/,
    /infra\/systemd\/newme-service-control\.sh/,
    /infra\/systemd\/newme-release-rollback\.sh/,
    /infra\/systemd\/newme-deploy\.sh/,
    /git hash-object "\$WORKTREE\/\$asset"/,
  ]) assert.match(deploy, pattern);
  assert.doesNotMatch(deploy, /manual_verified|CI_RUN_URL="manual"|RUN_ID" = "manual"/);

  const manual = run("infra/systemd/newme-deploy.sh", [
    "a".repeat(40),
    "manual",
    "not_required",
    "",
    "b".repeat(40),
  ]);
  assert.equal(manual.status, 64, manual.stderr);
});

test("immutable deploy records the prior release for guarded rollback before switching", async () => {
  const deploy = await read("scripts/deploy-immutable.sh");
  assert.match(deploy, /ROLLBACK=.*current\.rollback/);
  const rollbackSwitch = deploy.lastIndexOf('mv -Tf "$ROLLBACK_NEXT" "$ROLLBACK"');
  const currentSwitch = deploy.lastIndexOf('mv -Tf "$CURRENT_NEXT" "$CURRENT"');
  assert.ok(rollbackSwitch >= 0 && currentSwitch > rollbackSwitch);
  assert.match(deploy, /PREVIOUS_ROLLBACK/);
  assert.match(deploy, /ROLLBACK_CHANGED/);
  assert.match(deploy, /restore_rollback_link/);
  assert.match(deploy, /newme-release-rollback/);
});
