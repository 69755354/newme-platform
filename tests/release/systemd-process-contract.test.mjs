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
    assert.match(unit, /^User=ubuntu$/m);
    assert.match(unit, /^WorkingDirectory=\/opt\/newme\/current$/m);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/newme\/current\/node_modules\/next\/dist\/bin\/next start -p 3001$/m);
    assert.doesNotMatch(unit, /ExecStart=.*\b(?:npm|sh|bash)\b.*\bstart\b/);
    assert.match(unit, /^KillMode=control-group$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^SuccessExitStatus=143 SIGTERM$/m);
    assert.match(unit, /^StartLimitIntervalSec=300$/m);
    assert.match(unit, /^StartLimitBurst=3$/m);
    assert.match(unit, /^ExecStartPost=\+\/usr\/local\/libexec\/newme\/newme-readiness\.sh$/m);
    assert.match(unit, /^ExecStopPost=\+\/usr\/local\/libexec\/newme\/newme-forensic\.sh$/m);
    assert.match(unit, /^UMask=0077$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^CapabilityBoundingSet=$/m);
    assert.match(unit, /^AmbientCapabilities=$/m);
    assert.match(unit, /^ProtectSystem=full$/m);
    assert.match(unit, /^ProtectHome=true$/m);
    assert.match(unit, /^ReadOnlyPaths=\/opt\/newme\/releases$/m);
    assert.match(unit, /^PrivateDevices=true$/m);
    assert.match(unit, /^ProtectKernelTunables=true$/m);
    assert.match(unit, /^ProtectKernelModules=true$/m);
    assert.match(unit, /^ProtectKernelLogs=true$/m);
    assert.match(unit, /^ProtectControlGroups=true$/m);
    assert.match(unit, /^RestrictSUIDSGID=true$/m);
    assert.match(unit, /^LockPersonality=true$/m);
    assert.match(unit, /^RestrictRealtime=true$/m);
    assert.match(unit, /^RestrictNamespaces=true$/m);
    assert.match(unit, /^SystemCallArchitectures=native$/m);
    assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
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

test("deploy uses audited service control and an atomic release switch", async () => {
  const deploy = await read("scripts/deploy-immutable.sh");
  assert.doesNotMatch(deploy, /fuser\s+-k\s+3001\/tcp/);
  assert.match(deploy, /\$CONTROL" restart "deploy:\$ID:switch"/);
  assert.match(deploy, /\$CONTROL" restart "deploy:\$ID:rollback"/);
  assert.match(deploy, /mv -Tf "\$CURRENT_NEXT" "\$CURRENT"/);
});

test("versioned health probe accepts the deployed status and never mutates processes", async () => {
  const probe = await read("infra/observability/newme-service-health.py");
  assert.match(probe, /ACCEPTED_STATUSES = \{"ok", "healthy"\}/);
  assert.doesNotMatch(probe, /\b(?:pkill|kill|systemctl|fuser)\b/);
});


test("forensic log path, installer, and logrotate contract are aligned", async () => {
  const [hook, installer, rotate] = await Promise.all([
    read("infra/systemd/newme-forensic.sh"),
    read("scripts/install-systemd-assets.sh"),
    read("infra/logrotate/newme-forensic"),
  ]);
  assert.match(hook, /LOG_FILE="\$LOG_DIR\/newme-forensic\.log"/);
  assert.match(installer, /infra\/logrotate\/newme-forensic/);
  assert.match(installer, /var\/log\/newme-forensic\/newme-forensic\.log/);
  assert.match(rotate, /var\/log\/newme-forensic\/newme-forensic\.log/);
  assert.match(rotate, /create 0640 root adm/);
  assert.match(rotate, /maxsize 10M/);
});

test("installer replaces direct service sudo with the audited control boundary", async () => {
  const [installer, sudoers, deploy] = await Promise.all([
    read("scripts/install-systemd-assets.sh"),
    read("infra/sudoers/newme-platform"),
    read("infra/systemd/newme-deploy.sh"),
  ]);
  assert.match(installer, /infra\/sudoers\/newme-platform/);
  assert.match(installer, /install_control_sudoers\(\)/);
  const unitVerify = installer.indexOf('systemd-analyze verify "$UNIT"');
  const unitInstall = installer.indexOf('install -D -o root -g root -m 0644 "$UNIT"');
  assert.ok(unitVerify >= 0 && unitInstall > unitVerify, "unit verification must precede live installation");
  assert.match(installer, /systemd-analyze verify \/etc\/systemd\/system\/newme-platform\.service/);
  assert.match(installer, /visudo -cf "\$temporary"/);
  assert.match(installer, /mv -Tf "\$temporary" "\$dest"/);
  assert.match(installer, /sync -f "\$directory"/);
  assert.match(installer, /^visudo -c\r?$/m);
  assert.match(installer, /\/etc\/sudoers\.d\/newme-platform/);
  assert.match(installer, /\/etc\/sudoers\.d\/ubuntu-nopasswd/);
  assert.match(installer, /rm -f -- \/etc\/sudoers\.d\/ubuntu-nopasswd/);
  assert.match(installer, /sync -f \/etc\/sudoers\.d/);
  assert.match(sudoers, /NEWME_SERVICE_CONTROL/);
  assert.match(sudoers, /newme-service-control restart \*/);
  assert.match(sudoers, /newme-service-control reset-failed \*/);
  assert.match(sudoers, /newme-production-rollback status/);
  assert.match(sudoers, /newme-production-rollback receipt-key-inspect/);
  assert.doesNotMatch(sudoers, /newme-production-rollback receipt-key-inspect \*/);
  assert.match(sudoers, /newme-production-rollback execute \*/);
  assert.doesNotMatch(sudoers, /newme-service-control (?:start|stop|try-restart) \*/);
  assert.match(sudoers, /\/usr\/local\/sbin\/newme-deploy \*/);
  assert.doesNotMatch(sudoers, /\/opt\/newme\/deploy\/deploy\.sh/);
  assert.doesNotMatch(sudoers, /NOPASSWD:\s*ALL/);
  assert.doesNotMatch(sudoers, /\/usr\/bin\/systemctl (?:start|stop|restart)/);
  assert.match(installer, /infra\/systemd\/newme-deploy\.sh/);
  assert.match(installer, /git clone --bare/);
  assert.match(deploy, /release SHA must equal canonical main/);
  assert.match(deploy, /git@github\.com:69755354\/newme-platform\.git/);
  assert.match(deploy, /actions\/runs\/\$RUN_ID/);
  assert.match(deploy, /manual production deployment is disabled/);
  assert.match(deploy, /main lacks the production service-control unit-token guard/);
  assert.doesNotMatch(deploy, /manual_verified|CI_RUN_URL=\"manual\"/);
  assert.match(deploy, /worktree add --force/);
  assert.match(deploy, /bash \"\$WORKTREE\/scripts\/install-systemd-assets\.sh\"/);
  assert.doesNotMatch(deploy, /\/home\/ubuntu\/newme-platform/);
});

test("deploy refuses to build before versioned service assets are installed", async () => {
  const deploy = await read("scripts/deploy-immutable.sh");
  assert.match(deploy, /missing versioned release asset/);
  assert.match(deploy, /unexpected FragmentPath/);
  assert.match(deploy, /legacy drop-in ownership remains/);
});
