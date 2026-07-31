import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../../infra/observability/hermes-alert-state-v1.sh", import.meta.url),
);

test("explicit alert runtime overrides take precedence over host configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-config-precedence-"));
  const stateDir = join(root, "state");
  const eventsFile = join(root, "events.log");
  const notifier = join(root, "notifier.sh");
  const config = join(root, "host.env");

  await writeFile(notifier, [
    "#!/usr/bin/env bash",
    'printf "alert %s %s %s\\n" "$1" "$2" "$3" >> "$HERMES_ALERT_EVENTS"',
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(config, [
    "HERMES_ALERT_THRESHOLD=99",
    "HERMES_ALERT_NOTIFIER=/not/a/test/notifier",
    "HERMES_ALERT_DIAGNOSTIC=/not/a/test/diagnostic",
    "HERMES_ALERT_STATE_DIR=/not/a/test/state",
    "HERMES_ALERT_EVENTS=/not/a/test/events",
    "",
  ].join("\n"));

  const result = await new Promise((resolve) => {
    const child = spawn("bash", [script, "login-probe", "failure", "fixture"], {
      env: {
        ...process.env,
        HERMES_ALERT_CONFIG: config,
        HERMES_ALERT_STATE_DIR: stateDir,
        HERMES_ALERT_EVENTS: eventsFile,
        HERMES_ALERT_NOTIFIER: notifier,
        HERMES_ALERT_DIAGNOSTIC: "",
        HERMES_ALERT_THRESHOLD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(eventsFile, "utf8"), /^alert alert login-probe fixture$/m);
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=firing/);
});
