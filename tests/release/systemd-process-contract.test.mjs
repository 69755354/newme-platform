import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (path) => readFile(join(repoRoot, path), "utf8");

test("both versioned units directly supervise the immutable Next.js release", async () => {
  const units = await Promise.all([
    read("newme-platform.service"),
    read("infra/systemd/newme-platform.service"),
  ]);
  assert.equal(units[0], units[1], "duplicate unit sources must not drift");
  for (const unit of units) {
    assert.match(unit, /^WorkingDirectory=\/opt\/newme\/current$/m);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/newme\/current\/node_modules\/next\/dist\/bin\/next start -p 3001$/m);
    assert.doesNotMatch(unit, /ExecStart=.*\b(?:npm|sh|bash)\b.*\bstart\b/);
    assert.match(unit, /^KillMode=control-group$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^StartLimitIntervalSec=60$/m);
    assert.match(unit, /^StartLimitBurst=5$/m);
    assert.match(unit, /^ExecStartPost=\/usr\/local\/libexec\/newme\/newme-readiness\.sh$/m);
    assert.match(unit, /^ExecStopPost=\+\/usr\/local\/libexec\/newme\/newme-forensic\.sh$/m);
  }
});

test("forensic hook records exit, invocation, cgroup, port, and release identity", async () => {
  const hook = await read("infra/systemd/newme-forensic.sh");
  for (const token of [
    "SERVICE_RESULT", "EXIT_CODE", "EXIT_STATUS", "INVOCATION_ID",
    "CURRENT_RELEASE", "BUILD_ID", "MANIFEST_SHA256", "cgroup.procs",
    "sport = :3001", "_SYSTEMD_INVOCATION_ID",
  ]) assert.ok(hook.includes(token), `missing forensic token: ${token}`);
  assert.match(hook, /STOP_SENDER=not_available_from_exec_stop_post/);
});

test("maintenance drill defaults to plan/read-only and covers every required path", async () => {
  const drill = await read("scripts/systemd-recovery-drill.sh");
  assert.doesNotMatch(drill, /systemctl\s+(?:stop|start|restart|kill|reboot)/);
  for (const scenario of ["intentional stop", "abnormal exit", "orphan", "StartLimit", "reboot"]) {
    assert.ok(drill.includes(scenario), `missing drill path: ${scenario}`);
  }
});

test("deploy uses audited service control and fails closed on residual port ownership", async () => {
  const deploy = await read("scripts/deploy.sh");
  assert.doesNotMatch(deploy, /fuser\s+-k\s+3001\/tcp/);
  assert.match(deploy, /newme-service-control stop "deploy:\$DEPLOY_ID:swap"/);
  assert.match(deploy, /newme-service-control start "deploy:\$DEPLOY_ID:swap"/);
  assert.match(deploy, /Port 3001 still held after systemd stop; refusing broad kill/);
});
