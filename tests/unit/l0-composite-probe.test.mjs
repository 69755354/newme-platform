import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const composite = bashPath(new URL("../../infra/observability/l0-composite-probe.sh", import.meta.url));

function executable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return bashPath(path);
}

function runComposite({ health = 0, login = 0, dependency = 0, sentryStart = 0, sentryFinish = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "newme-l0-composite-"));
  const eventsFile = join(root, "events.log");
  const sentry = executable(join(root, "sentry.sh"), `
sentry_checkin_start() {
  printf 'sentry-start:%s\\n' "$1" >> "$EVENTS_FILE"
  return "\${FAKE_SENTRY_START_RC:-0}"
}
sentry_checkin_finish() {
  printf 'sentry-finish:%s:%s\\n' "$1" "$2" >> "$EVENTS_FILE"
  return "\${FAKE_SENTRY_FINISH_RC:-0}"
}
`);
  const alert = executable(join(root, "alert.sh"), `#!/usr/bin/env bash
printf 'hermes:%s:%s:%s\\n' "$1" "$2" "$3" >> "$EVENTS_FILE"
printf 'transition=none capture=0\\n'
`);
  const capture = executable(join(root, "capture.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const probe = (name, status) => executable(join(root, `${name}.sh`), `#!/usr/bin/env bash
printf 'probe:${name}\\n' >> "$EVENTS_FILE"
exit ${status}
`);

  const result = spawnSync("bash", [composite], {
    encoding: "utf8",
    env: {
      ...process.env,
      EVENTS_FILE: bashPath(eventsFile),
      SENTRY_CHECKIN_SCRIPT: sentry,
      HERMES_ALERT_STATE_SCRIPT: alert,
      INCIDENT_CAPTURE_SCRIPT: capture,
      HEALTH_PROBE: probe("health", health),
      LOGIN_PROBE: probe("login", login),
      DEPENDENCY_PROBE: probe("dependency", dependency),
      FAKE_SENTRY_START_RC: String(sentryStart),
      FAKE_SENTRY_FINISH_RC: String(sentryFinish),
    },
  });
  const events = readFileSync(eventsFile, "utf8");
  return { result, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("composite monitor reports one successful check-in after all children pass", () => {
  const run = runComposite();
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(run.events.trim().split("\n"), [
      "sentry-start:newme-health-check",
      "probe:health",
      "probe:login",
      "probe:dependency",
      "sentry-finish:newme-health-check:0",
      "hermes:l0-composite-sentry:recovery:composite Sentry transport recovered",
    ]);
  } finally {
    run.cleanup();
  }
});

test("composite monitor runs every child and reports an error when one child fails", () => {
  const run = runComposite({ login: 7 });
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.events, /probe:health\nprobe:login\nprobe:dependency/);
    assert.match(run.events, /sentry-finish:newme-health-check:1/);
  } finally {
    run.cleanup();
  }
});

test("composite monitor routes Sentry start and finish failures through Hermes", () => {
  for (const options of [{ sentryStart: 1 }, { sentryFinish: 1 }]) {
    const run = runComposite(options);
    try {
      assert.equal(run.result.status, 1, run.result.stderr);
      assert.match(run.events, /probe:health\nprobe:login\nprobe:dependency/);
      assert.match(run.events, /hermes:l0-composite-sentry:failure:composite Sentry check-in transport failed/);
      if (options.sentryStart) assert.doesNotMatch(run.events, /sentry-finish/);
    } finally {
      run.cleanup();
    }
  }
});
