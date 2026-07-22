import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const script = new URL("../../infra/observability/hermes-alert.sh", import.meta.url);

async function runAlert(stateDir, command, event, summary, threshold = "2") {
  const result = await new Promise((resolve) => {
    const child = spawn("bash", [script.pathname, "login-probe", event, summary], {
      env: {
        ...process.env,
        HERMES_ALERT_STATE_DIR: stateDir,
        HERMES_ALERT_THRESHOLD: threshold,
        HERMES_ALERT_COMMAND: command,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

test("persists threshold state and suppresses a continuing failure", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermes-alert-state-"));
  const eventsFile = join(stateDir, "events.log");
  const notifier = join(stateDir, "notifier.sh");
  await writeFile(notifier, "#!/usr/bin/env bash\ncat >> \"$HERMES_ALERT_EVENTS\"\n", { mode: 0o700 });

  const env = { HERMES_ALERT_EVENTS: eventsFile };
  process.env.HERMES_ALERT_EVENTS = eventsFile;
  await runAlert(stateDir, notifier, "failure", "first failure");
  const first = await readFile(eventsFile, "utf8").catch(() => "");
  assert.equal(first, "");
  await runAlert(stateDir, notifier, "failure", "threshold failure");
  const alerted = await readFile(eventsFile, "utf8");
  assert.match(alerted, /event=alert/);
  assert.match(alerted, /key=login-probe/);
  await runAlert(stateDir, notifier, "failure", "same failure again");
  assert.equal((await readFile(eventsFile, "utf8")).match(/event=alert/g)?.length, 1);
  assert.equal((await readFile(join(stateDir, "login-probe.state"), "utf8")).includes("status=firing"), true);
  delete process.env.HERMES_ALERT_EVENTS;
});

test("sends one recovery and allows a later independent incident", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermes-alert-recovery-"));
  const eventsFile = join(stateDir, "events.log");
  const notifier = join(stateDir, "notifier.sh");
  await writeFile(notifier, "#!/usr/bin/env bash\ncat >> \"$HERMES_ALERT_EVENTS\"\n", { mode: 0o700 });
  process.env.HERMES_ALERT_EVENTS = eventsFile;

  await runAlert(stateDir, notifier, "failure", "failure one");
  await runAlert(stateDir, notifier, "failure", "failure two");
  await runAlert(stateDir, notifier, "recovery", "recovered");
  await runAlert(stateDir, notifier, "recovery", "still recovered");
  await runAlert(stateDir, notifier, "failure", "new failure one");
  await runAlert(stateDir, notifier, "failure", "new failure two");

  const events = await readFile(eventsFile, "utf8");
  assert.equal((events.match(/event=alert/g) || []).length, 2);
  assert.equal((events.match(/event=recovery/g) || []).length, 1);
  delete process.env.HERMES_ALERT_EVENTS;
});
