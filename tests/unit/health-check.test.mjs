import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bashPath = (value) => {
  const path = value instanceof URL ? fileURLToPath(value) : String(value);
  if (process.platform !== "win32") return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
};

const healthCheck = bashPath(new URL("../../infra/observability/health-check.sh", import.meta.url));

function executable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return path;
}

const SYSTEMCTL_ALL_ENABLED_AND_ACTIVE = `#!/usr/bin/env bash
case "$1" in
  is-enabled) printf 'enabled\\n' ;;
  is-active) exit 0 ;;
esac
`;

function runHealth(dfSource, systemctlSource = SYSTEMCTL_ALL_ENABLED_AND_ACTIVE) {
  const root = mkdtempSync(join(tmpdir(), "newme-health-probe-"));
  const bin = join(root, "bin");
  const alert = join(root, "alert.sh");
  const loadavg = join(root, "loadavg");
  mkdirSync(bin);
  writeFileSync(loadavg, "0.01 0.02 0.03 1/100 1\n", "utf8");
  executable(join(bin, "df"), dfSource);
  executable(join(bin, "free"), "#!/usr/bin/env bash\nprintf 'Mem: 100 10 90 0 0 0\\n'\n");
  executable(join(bin, "nproc"), "#!/usr/bin/env bash\nprintf '4\\n'\n");
  executable(join(bin, "ps"), "#!/usr/bin/env bash\nprintf 'one\\ntwo\\n'\n");
  executable(join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  executable(join(bin, "systemctl"), systemctlSource);
  executable(alert, "#!/usr/bin/env bash\nprintf 'transition=none capture=0\\n'\n");
  const result = spawnSync("bash", ["-c", 'PATH="$FAKE_BIN:$PATH"; export PATH; exec bash "$1"', "health-fixture", healthCheck], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_BIN: bashPath(bin),
      HERMES_ALERT_STATE_SCRIPT: bashPath(alert),
      LOADAVG_FILE: bashPath(loadavg),
    },
  });
  return { result, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("health check fails closed when a host metric command is unavailable", () => {
  const run = runHealth("#!/usr/bin/env bash\nexit 2\n");
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.result.stdout, /\[PROBE_ERROR\] disk metric collection failed/);
    assert.doesNotMatch(run.result.stdout, / OK disk=/);
    assert.doesNotMatch(run.result.stdout, /\[\$TIMESTAMP\]/);
  } finally {
    run.cleanup();
  }
});

test("health check reports OK when every metric and service probe succeeds", () => {
  const run = runHealth("#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 100 10 90 10%% /\\n'\n");
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.result.stdout, / OK disk=10% mem=10% cpu=[0-9]+% proc=2/);
    assert.doesNotMatch(run.result.stdout, /PROBE_ERROR/);
  } finally {
    run.cleanup();
  }
});

const HEALTHY_DF =
  "#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 100 10 90 10%% /\\n'\n";

// The unit whose program directory the openclaw migration archived is retired by
// mask on the host; the probe must stop asserting its liveness, or every release
// fails its post-switch health gate on a unit that cannot start.
test("health check skips a masked unit instead of alerting on it forever", () => {
  const run = runHealth(HEALTHY_DF, `#!/usr/bin/env bash
case "$1" in
  is-enabled) case "$2" in hermes-worker) printf 'masked\\n'; exit 1 ;; *) printf 'enabled\\n' ;; esac ;;
  is-active) case "$3" in hermes-worker) exit 3 ;; *) exit 0 ;; esac ;;
esac
`);
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.result.stdout, /retired service skipped: hermes-worker \(masked\)/);
    assert.doesNotMatch(run.result.stdout, /HERMES_DOWN/);
  } finally {
    run.cleanup();
  }
});

// Negative control: without this arm the change above would be indistinguishable
// from deleting the service probe.
test("health check still alerts when an unmasked unit is inactive", () => {
  const run = runHealth(HEALTHY_DF, `#!/usr/bin/env bash
case "$1" in
  is-enabled) printf 'enabled\\n' ;;
  is-active) case "$3" in hermes-worker) exit 3 ;; *) exit 0 ;; esac ;;
esac
`);
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.result.stdout, /\[HERMES_DOWN\] hermes-worker inactive/);
    assert.doesNotMatch(run.result.stdout, /retired service skipped/);
  } finally {
    run.cleanup();
  }
});

// A disabled-but-present unit is not a retirement declaration either.
test("health check alerts on a disabled inactive unit", () => {
  const run = runHealth(HEALTHY_DF, `#!/usr/bin/env bash
case "$1" in
  is-enabled) case "$2" in hermes-worker) printf 'disabled\\n'; exit 1 ;; *) printf 'enabled\\n' ;; esac ;;
  is-active) case "$3" in hermes-worker) exit 3 ;; *) exit 0 ;; esac ;;
esac
`);
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.result.stdout, /\[HERMES_DOWN\] hermes-worker inactive/);
  } finally {
    run.cleanup();
  }
});

// The probe must keep naming all three units, so a retirement stays a host
// declaration rather than a silent edit to the watch list.
test("health check still watches all three hermes units", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../infra/observability/health-check.sh", import.meta.url), "utf8"));
  assert.match(source, /for service in hermes-bridge hermes-dashboard hermes-worker; do/);
  assert.match(source, /masked \| masked-runtime\)/);
});

test("legacy Supabase monitor delegates without starting an independent Sentry check-in", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../infra/observability/supabase-pool-monitor.sh", import.meta.url), "utf8"));
  assert.match(source, /exec bash "\$DEPENDENCY_PROBE"/);
  assert.doesNotMatch(source, /sentry_checkin_|supabase-monitor/);
});
