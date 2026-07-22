import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const script = new URL("../../infra/observability/hermes-alert-state-v1.sh", import.meta.url);

async function runAlert({ stateDir, notifier, event, summary, expectCode = 0, threshold }) {
  const env = {
    ...process.env,
    HERMES_ALERT_STATE_DIR: stateDir,
  };
  if (notifier !== undefined) env.HERMES_ALERT_NOTIFIER = notifier;
  if (threshold !== undefined) env.HERMES_ALERT_THRESHOLD = threshold;

  const result = await new Promise((resolve) => {
    const child = spawn("bash", [script.pathname, "login-probe", event, summary], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, expectCode, result.stderr);
  return result.stdout;
}

async function makeNotifier(dir, body) {
  const notifier = join(dir, "notifier.sh");
  await writeFile(notifier, body, { mode: 0o700 });
  return notifier;
}

async function events(stateDir) {
  return readFile(join(stateDir, "events.log"), "utf8").catch(() => "");
}

test("default threshold is two, suppresses duplicates, recovers once, and re-alerts later", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermes-alert-default-"));
  const notifier = await makeNotifier(
    stateDir,
    "#!/usr/bin/env bash\nprintf '%s %s %s\\n' "$1" "$2" "$3" >> "$HERMES_ALERT_EVENTS"\n",
  );
  process.env.HERMES_ALERT_EVENTS = join(stateDir, "events.log");

  await runAlert({ stateDir, notifier, event: "failure", summary: "first failure" });
  assert.equal((await events(stateDir)).length, 0);
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=ok/);
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /failure_count=1/);

  await runAlert({ stateDir, notifier, event: "failure", summary: "threshold failure" });
  await runAlert({ stateDir, notifier, event: "failure", summary: "same failure again" });
  await runAlert({ stateDir, notifier, event: "recovery", summary: "recovered" });
  await runAlert({ stateDir, notifier, event: "recovery", summary: "still recovered" });
  await runAlert({ stateDir, notifier, event: "failure", summary: "new failure one" });
  await runAlert({ stateDir, notifier, event: "failure", summary: "new failure two" });

  const log = await events(stateDir);
  assert.equal((log.match(/^alert /gm) || []).length, 2);
  assert.equal((log.match(/^recovery /gm) || []).length, 1);
  delete process.env.HERMES_ALERT_EVENTS;
});

test("failed alert and recovery transport remain retryable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermes-alert-retry-"));
  const failing = await makeNotifier(stateDir, "#!/usr/bin/env bash\nexit 1\n");
  const working = await makeNotifier(
    stateDir,
    "#!/usr/bin/env bash\nprintf '%s %s %s\\n' "$1" "$2" "$3" >> "$HERMES_ALERT_EVENTS"\n",
  );
  process.env.HERMES_ALERT_EVENTS = join(stateDir, "events.log");

  await runAlert({ stateDir, notifier: failing, event: "failure", summary: "failure one" });
  await runAlert({ stateDir, notifier: failing, event: "failure", summary: "failure two", expectCode: 1 });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_failure/);
  await runAlert({ stateDir, notifier: working, event: "failure", summary: "retry alert" });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=firing/);

  await runAlert({ stateDir, notifier: failing, event: "recovery", summary: "recovery fails", expectCode: 1 });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_recovery/);
  await runAlert({ stateDir, notifier: working, event: "recovery", summary: "retry recovery" });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=ok/);
  assert.equal((await events(stateDir)).match(/^recovery /gm)?.length, 1);
  delete process.env.HERMES_ALERT_EVENTS;
});

test("initializes a persistent user directory and exposes missing notifier or path errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-init-"));
  const stateDir = join(root, "nested", "state");
  const missing = join(root, "missing-notifier");
  await runAlert({ stateDir, notifier: missing, event: "failure", summary: "first failure" });
  await runAlert({ stateDir, notifier: missing, event: "failure", summary: "threshold failure", expectCode: 1 });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_failure/);

  const notDirectory = join(root, "not-a-directory");
  await writeFile(notDirectory, "occupied");
  await runAlert({ stateDir: notDirectory, notifier: missing, event: "failure", summary: "bad directory", expectCode: 1 });
});
