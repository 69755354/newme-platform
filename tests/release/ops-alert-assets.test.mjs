// Audit 2026-11-20 (F1/F3/F6, H1, M6): the ops alert sender, the backup checks, the weekly restore drill and the two
// Meta event senders are installed by the gated release (scripts/install-systemd-assets.sh), inside its rollback set,
// instead of by hand.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const installer = read("scripts/install-systemd-assets.sh");
const managed = /^MANAGED=\(\n([\s\S]*?)\n\)/m.exec(installer)[1];

const ASSETS = {
  "/usr/local/libexec/newme/newme-whatsapp-alert.sh": "infra/alerts/newme-whatsapp-alert.sh",
  "/usr/local/libexec/newme/newme-backup-lib.sh": "infra/backup/newme-backup-lib.sh",
  "/usr/local/libexec/newme/newme-backup-onfailure.sh": "infra/backup/newme-backup-onfailure.sh",
  "/usr/local/libexec/newme/newme-backup-freshness.sh": "infra/backup/newme-backup-freshness.sh",
  "/usr/local/libexec/newme/newme-restore-drill.sh": "infra/backup/newme-restore-drill.sh",
  "/usr/local/libexec/newme/newme-db-backup.sh": "infra/backup/newme-db-backup.sh",
  "/etc/systemd/system/newme-restore-drill.service": "infra/backup/newme-restore-drill.service",
  "/etc/systemd/system/newme-restore-drill.timer": "infra/backup/newme-restore-drill.timer",
  "/etc/systemd/system/newme-wa-capi-send.service": "infra/systemd/newme-wa-capi-send.service",
  "/etc/systemd/system/newme-wa-capi-send.timer": "infra/systemd/newme-wa-capi-send.timer",
  "/etc/systemd/system/newme-meta-crm-send.service": "infra/systemd/newme-meta-crm-send.service",
  "/etc/systemd/system/newme-meta-crm-send.timer": "infra/systemd/newme-meta-crm-send.timer",
};

test("every ops asset is in the remembered (rollback) set and its source exists in the repository", () => {
  for (const [dest, source] of Object.entries(ASSETS)) {
    assert.ok(managed.split("\n").map((l) => l.trim()).includes(dest), `${dest} is not in MANAGED`);
    assert.ok(existsSync(join(root, source)), `${source} is missing`);
  }
  for (const unit of ["newme-restore-drill.service", "newme-restore-drill.timer"]) assert.ok(installer.includes(`infra/backup/${unit}`), unit);
  for (const unit of ["newme-wa-capi-send.service", "newme-wa-capi-send.timer", "newme-meta-crm-send.service", "newme-meta-crm-send.timer"]) {
    assert.ok(installer.includes(`infra/systemd/${unit}`), unit);
  }
  assert.match(installer, /install -D -o root -g root -m 0755 "\$ROOT\/infra\/alerts\/newme-whatsapp-alert\.sh" "\$OPS_LIBEXEC\/newme-whatsapp-alert\.sh"/);
  assert.match(installer, /install -D -o root -g root -m 0644 "\$ROOT\/infra\/backup\/newme-backup-lib\.sh"/, "the sourced library is not executable");
  assert.match(installer, /install -D -o root -g root -m 0644 "\$ROOT\/\$ops_unit" "\/etc\/systemd\/system\/\$\{ops_unit##\*\/\}"/);
});

test("the ops files are installed inside the open transaction and before the daemon-reload", () => {
  const trap = installer.search(/^trap rollback_on_error EXIT\r?$/m);
  const opsInstall = installer.indexOf('"$ROOT/infra/alerts/newme-whatsapp-alert.sh"');
  const reload = installer.search(/^systemctl daemon-reload$/m);
  assert.ok(trap >= 0 && trap < opsInstall && opsInstall < reload);
});

test("optional timers are enabled only after their flag; the wa-capi timer's enablement is left as the host has it", () => {
  const reload = installer.search(/^systemctl daemon-reload$/m);
  const after = installer.slice(reload);
  assert.match(after, /if \[ -x \/usr\/lib\/postgresql\/17\/bin\/initdb \] && \[ -x \/usr\/lib\/postgresql\/17\/bin\/pg_ctl \]; then\n\s*systemctl enable --now newme-restore-drill\.timer/);
  assert.match(after, /META_PIXEL_ID=[\s\S]*META_CAPI_ACCESS_TOKEN=[\s\S]*systemctl enable --now newme-meta-crm-send\.timer/);
  assert.ok(!/enable[^\n]*newme-wa-capi-send/.test(installer), "the installer never changes the wa-capi timer's enablement");
  assert.ok(!/apt-get|apt install/.test(installer), "packages stay a documented manual step");
  assert.match(read("infra/backup/newme-restore-drill.timer"), /^# STATUS: after-flag$/m);
  assert.match(read("docs/runbooks/s17-ops-readiness.md"), /create_main_cluster = false[\s\S]*apt-get install -y postgresql-17/);
});

test("both Meta senders run every 10 minutes the same way, alert on failure and send for real", () => {
  for (const [name, script] of [["newme-wa-capi-send", "scripts/whatsapp-capi-send.mjs"], ["newme-meta-crm-send", "scripts/meta-crm-events-send.mjs"]]) {
    const service = read(`infra/systemd/${name}.service`);
    const timer = read(`infra/systemd/${name}.timer`);
    assert.match(service, /^Type=oneshot$/m, name);
    assert.match(service, /^OnFailure=newme-unit-alert@%n\.service$/m, name);
    assert.match(service, /^WorkingDirectory=\/opt\/newme\/current$/m, name);
    assert.match(service, new RegExp(`^ExecStart=/usr/bin/node ${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --execute$`, "m"), name);
    assert.match(service, /^EnvironmentFile=\/etc\/newme\/newme-runtime\.env$/m, name);
    assert.match(service, /^EnvironmentFile=\/etc\/newme\/capi-wa\.env$/m, name);
    assert.match(service, /^ProtectSystem=strict$/m, name);
    assert.match(timer, /^OnCalendar=\*:0\/10$/m, name);
    assert.match(timer, /^Persistent=true$/m, name);
    assert.match(timer, /^WantedBy=timers\.target$/m, name);
    assert.ok(existsSync(join(root, script)), script);
  }
});

test("optional timers are enabled only after every installer check, and a rollback disables a timer it removes", () => {
  const lastCheck = installer.indexOf("refresh-protection \"$SOURCE_SHA\"");
  const drillEnable = installer.indexOf("systemctl enable --now newme-restore-drill.timer");
  const crmEnable = installer.indexOf("systemctl enable --now newme-meta-crm-send.timer");
  const done = installer.indexOf('echo "backup=$BACKUP rollback=');
  assert.ok(lastCheck > 0 && lastCheck < drillEnable && drillEnable < crmEnable && crmEnable < done);
  assert.ok(installer.search(/^systemd-analyze verify \/etc\/systemd\/system\/newme-platform\.service$/m) < drillEnable);
  const rollback = read("scripts/rollback-systemd-assets.sh");
  assert.match(rollback, /case "\$dest" in \/etc\/systemd\/system\/\*\.timer\) systemctl disable --now --no-reload "\$\{dest##\*\/\}" 2>\/dev\/null \|\| true ;; esac\n\s*rm -f -- "\$dest" \|\| return 1/);
});
