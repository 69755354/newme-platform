// S28: the shipped units are templates that do nothing until the flag is set; the sheets and the NAS are never
// written by anything that is not the worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const D = "infra/os-drive-sync";

test("units are after-flag templates and the env example ships disabled", () => {
  for (const f of ["newme-os-drive-sync.service", "newme-os-drive-sync.timer", "newme-os-drive-reconcile.service", "newme-os-drive-reconcile.timer"]) {
    assert.match(read(`${D}/${f}`), /^# STATUS: after-flag/m, f);
  }
  assert.match(read(`${D}/os-drive-sync.env.example`), /^OS_DRIVE_SYNC_ENABLED=false$/m);
});

test("the 5-minute timer and the nightly reconcile fire where the design says", () => {
  assert.match(read(`${D}/newme-os-drive-sync.timer`), /^OnCalendar=\*-\*-\* \*:0\/5:00$/m);
  assert.match(read(`${D}/newme-os-drive-reconcile.timer`), /^OnCalendar=\*-\*-\* 02:30:00 Asia\/Dubai$/m);
  assert.match(read(`${D}/newme-os-drive-reconcile.timer`), /^Persistent=true$/m);
});

test("services are one-shot, hardened, run the worker from /opt/newme/current and only write their state directory", () => {
  for (const f of ["newme-os-drive-sync.service", "newme-os-drive-reconcile.service"]) {
    const t = read(`${D}/${f}`);
    assert.match(t, /^Type=oneshot$/m); assert.match(t, /^WorkingDirectory=\/opt\/newme\/current$/m);
    assert.match(t, /^ProtectSystem=strict$/m); assert.match(t, /^ReadWritePaths=\/var\/lib\/newme-os-drive-sync$/m);
    assert.match(t, /^NoNewPrivileges=true$/m); assert.match(t, /^UMask=0077$/m);
    assert.match(t, /^EnvironmentFile=\/etc\/newme\/newme-runtime\.env$/m);
    assert.match(t, /scripts\/os-drive-nas-sync\.mjs/); assert.doesNotMatch(t, /\/run\//);
    assert.doesNotMatch(t, /--execute|SUPABASE_SERVICE_ROLE_KEY=|PASSWORD|TOKEN=/);
  }
  assert.match(read(`${D}/newme-os-drive-reconcile.service`), /--reconcile/);
});

test("systemd-analyze accepts the units", { skip: spawnSync("systemd-analyze", ["--version"]).status !== 0 }, () => {
  const r = spawnSync("systemd-analyze", ["verify", "--man=no", ...["sync.service", "sync.timer", "reconcile.service", "reconcile.timer"].map((n) => join(root, `${D}/newme-os-drive-${n}`))], { encoding: "utf8" });
  const bad = (r.stderr + r.stdout).split("\n").filter((l) => l.includes("newme-os-drive") && !/Failed to prepare filename|EnvironmentFile|newme-backup-alert|\/opt\/newme|\/usr\/bin\/(flock|node)|Command .* is not executable|not found|doesn't exist/.test(l));
  assert.deepEqual(bad, []);
});

test("the worker cannot be told to write more than its cap by accident: default cap is 200 and sales writes are column X only", () => {
  const w = read("scripts/os-drive-nas-sync.mjs"); const lib = read("src/lib/os-drive-sync.mjs");
  assert.match(lib, /maxWrites: 200/); assert.match(lib, /\^\$\{clidColumn\}\\\\d\+\$/);
  assert.doesNotMatch(w, /values:clear|deleteDimension|spreadsheets\.batchUpdate/);
});
