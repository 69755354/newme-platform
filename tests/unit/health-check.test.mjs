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

function runHealth(dfSource) {
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
  executable(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
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

test("legacy Supabase monitor delegates without starting an independent Sentry check-in", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../infra/observability/supabase-pool-monitor.sh", import.meta.url), "utf8"));
  assert.match(source, /exec bash "\$DEPENDENCY_PROBE"/);
  assert.doesNotMatch(source, /sentry_checkin_|supabase-monitor/);
});
