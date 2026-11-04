// S7 / review 5-logging-monitoring F1: the Sentry check-in stopped on 2026-10-27
// while the local state stayed "ok". Cause (inferred, the evidence was cleared by
// a reboot): the cron job runs `flock -n`, probes start incident-capture.sh in the
// background and it inherits the lock descriptor; one hung command in it kept the
// lock, every later run skipped silently. These tests pin the three defences:
// the capture releases inherited descriptors and is time-bounded, the composite
// run is time-bounded, and a separate watchdog alerts on a stale heartbeat.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = (name) => fileURLToPath(new URL(`../../infra/observability/${name}`, import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stubBin(root, name, body) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(root, "bin", name), 0o755);
}

test("a hung command inside incident-capture cannot keep the cron lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "newme-l0-hang-"));
  stubBin(root, "journalctl", "sleep 60");
  const lock = join(root, "l0.lock");
  // Same shape as production: a cron-locked parent starts the capture in the
  // background and exits; the capture inherits the lock descriptor.
  const parent = join(root, "parent.sh");
  writeFileSync(parent, `#!/usr/bin/env bash\nbash "${dir("incident-capture.sh")}" test hang &\nexit 0\n`);
  chmodSync(parent, 0o755);
  const child = spawn("flock", ["-n", lock, parent], {
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, INCIDENT_BASE_DIR: join(root, "incidents"), INCIDENT_CAPTURE_TIMEOUT_SECONDS: "3" },
    stdio: "ignore", detached: true,
  });
  try {
    await sleep(1200);
    const probe = spawnSync("flock", ["-n", lock, "true"]);
    assert.equal(probe.status, 0, "lock must be free while the capture is still hung");
    await sleep(4500);
    const alive = spawnSync("pgrep", ["-f", `${join(root, "incidents")}`]);
    assert.notEqual(alive.status, 0, "the hung capture is killed by its time bound");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("composite probe is bounded by a hard timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "newme-l0-bound-"));
  const hang = join(root, "hang.sh");
  writeFileSync(hang, "#!/usr/bin/env bash\nsleep 30\n");
  chmodSync(hang, 0o755);
  const ok = join(root, "ok.sh");
  writeFileSync(ok, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(ok, 0o755);
  const started = Date.now();
  const result = spawnSync("bash", [dir("l0-composite-probe.sh")], {
    encoding: "utf8",
    env: { ...process.env, L0_COMPOSITE_TIMEOUT_SECONDS: "2", HEALTH_PROBE: hang, LOGIN_PROBE: ok, DEPENDENCY_PROBE: ok,
      SENTRY_CHECKIN_SCRIPT: join(root, "missing.sh"), HERMES_ALERT_STATE_SCRIPT: ok, INCIDENT_CAPTURE_SCRIPT: ok,
      L0_HEARTBEAT_FILE: join(root, "hb") },
  });
  assert.ok(Date.now() - started < 12_000, "run ended by the bound instead of hanging");
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(root, "hb")), false, "a killed run writes no heartbeat");
});

test("a finished composite run writes a heartbeat", () => {
  const root = mkdtempSync(join(tmpdir(), "newme-l0-hb-"));
  const ok = join(root, "ok.sh");
  writeFileSync(ok, "#!/usr/bin/env bash\nprintf 'transition=none capture=0\\n'\nexit 0\n");
  chmodSync(ok, 0o755);
  spawnSync("bash", [dir("l0-composite-probe.sh")], {
    env: { ...process.env, HEALTH_PROBE: ok, LOGIN_PROBE: ok, DEPENDENCY_PROBE: ok,
      SENTRY_CHECKIN_SCRIPT: join(root, "missing.sh"), HERMES_ALERT_STATE_SCRIPT: ok, INCIDENT_CAPTURE_SCRIPT: ok,
      L0_HEARTBEAT_FILE: join(root, "hb") },
  });
  assert.match(readFileSync(join(root, "hb"), "utf8"), /^\d{10}\n$/);
});

test("watchdog alerts on a stale heartbeat and recovers on a fresh one", () => {
  const root = mkdtempSync(join(tmpdir(), "newme-l0-wd-"));
  const log = join(root, "alerts.log");
  const alert = join(root, "alert.sh");
  writeFileSync(alert, `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "$1" "$2" "$3" >> "${log}"\n`);
  chmodSync(alert, 0o755);
  const hb = join(root, "hb");
  const run = (now) => spawnSync("bash", [dir("l0-watchdog.sh")], {
    env: { ...process.env, L0_HEARTBEAT_FILE: hb, HERMES_ALERT_STATE_SCRIPT: alert, L0_STALE_SECONDS: "420", L0_WATCHDOG_NOW: String(now), L0_WATCHDOG_IGNORE_UPTIME: "1" },
  });
  writeFileSync(hb, "1000000\n");
  run(1000100);
  run(1000600);
  run(1000000 + 500 + 700);
  writeFileSync(hb, "1001200\n");
  run(1001260);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(lines.map((l) => l.split("|").slice(0, 2).join("|")), [
    "l0-heartbeat-stale|recovery", "l0-heartbeat-stale|failure", "l0-heartbeat-stale|failure", "l0-heartbeat-stale|recovery",
  ]);
  assert.match(lines[1], /600s old/);
});

test("watchdog treats a missing heartbeat as stale only once the host has been up long enough", () => {
  const root = mkdtempSync(join(tmpdir(), "newme-l0-wd2-"));
  const log = join(root, "alerts.log");
  const alert = join(root, "alert.sh");
  writeFileSync(alert, `#!/usr/bin/env bash\nprintf '%s\\n' "$2" >> "${log}"\n`);
  chmodSync(alert, 0o755);
  spawnSync("bash", [dir("l0-watchdog.sh")], { env: { ...process.env, L0_HEARTBEAT_FILE: join(root, "none"), HERMES_ALERT_STATE_SCRIPT: alert, L0_WATCHDOG_IGNORE_UPTIME: "1" } });
  assert.equal(readFileSync(log, "utf8").trim(), "failure");
});
