import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const script = new URL("../../infra/observability/hermes-alert-state-v1.sh", import.meta.url);
const adapter = new URL("../../infra/observability/hermes-alert-notifier-v1.sh", import.meta.url);

async function runAlert({ stateDir, notifier, eventsFile, event, summary, expectCode = 0, threshold, extraEnv = {} }) {
  const env = {
    ...process.env,
    HERMES_ALERT_STATE_DIR: stateDir,
    HERMES_ALERT_EVENTS: eventsFile || "",
    ...extraEnv,
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

async function makeNotifier(dir, body, name = "notifier.sh") {
  const notifier = join(dir, name);
  await writeFile(notifier, body, { mode: 0o700 });
  return notifier;
}

async function events(eventsFile) {
  return readFile(eventsFile, "utf8").catch(() => "");
}

async function runCommand(command, args, env, expectCode = 0) {
  const result = await new Promise((resolve) => {
    const child = spawn("bash", [command.pathname, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, expectCode, result.stderr);
}

test("adapter calls source-only production functions and direct execution is inert", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-adapter-"));
  const library = join(root, "hermes-alert.sh");
  const eventsFile = join(root, "events.log");
  await writeFile(library, [
    "#!/usr/bin/env bash",
    'hermes_alert() { printf "alert %s %s %s\\n" "$1" "$2" "$3" >> "$HERMES_ALERT_EVENTS"; }',
    'hermes_ok() { printf "recovery %s\\n" "$1" >> "$HERMES_ALERT_EVENTS"; }',
    "",
  ].join("\n"), { mode: 0o700 });

  await runCommand(new URL("file://" + library), [], { HERMES_ALERT_EVENTS: eventsFile });
  assert.equal(await events(eventsFile), "");

  const env = { HERMES_ALERT_LIBRARY: library, HERMES_ALERT_EVENTS: eventsFile };
  await runCommand(adapter, ["alert", "login-probe", "threshold reached"], env);
  await runCommand(adapter, ["recovery", "login-probe", "probe recovered"], env);
  const log = await events(eventsFile);
  assert.equal((log.match(/^alert /gm) || []).length, 1);
  assert.equal((log.match(/^recovery /gm) || []).length, 1);
});


const recordingNotifier = [
  "#!/usr/bin/env bash",
  'printf "%s %s %s\\n" "$1" "$2" "$3" >> "$HERMES_ALERT_EVENTS"',
  "",
].join("\n");

test("default threshold is two, suppresses duplicates, recovers once, and re-alerts later", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermes-alert-default-"));
  const eventsFile = join(stateDir, "events.log");
  const notifier = await makeNotifier(stateDir, recordingNotifier);

  await runAlert({ stateDir, notifier, eventsFile, event: "failure", summary: "first failure" });
  assert.equal((await events(eventsFile)).length, 0);
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=ok/);
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /failure_count=1/);

  await runAlert({ stateDir, notifier, eventsFile, event: "failure", summary: "threshold failure" });
  await runAlert({ stateDir, notifier, eventsFile, event: "failure", summary: "same failure again" });
  await runAlert({ stateDir, notifier, eventsFile, event: "recovery", summary: "recovered" });
  await runAlert({ stateDir, notifier, eventsFile, event: "recovery", summary: "still recovered" });
  await runAlert({ stateDir, notifier, eventsFile, event: "failure", summary: "new failure one" });
  await runAlert({ stateDir, notifier, eventsFile, event: "failure", summary: "new failure two" });

  const log = await events(eventsFile);
  assert.equal((log.match(/^alert /gm) || []).length, 2);
  assert.equal((log.match(/^recovery /gm) || []).length, 1);
});

test("adapter transport failures remain retryable for alert and recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-retry-"));
  const stateDir = join(root, "state");
  const eventsFile = join(root, "events.log");
  const library = join(root, "hermes-alert.sh");
  await writeFile(library, [
    "#!/usr/bin/env bash",
    'hermes_alert() { printf "alert %s %s %s\\n" "$1" "$2" "$3" >> "$HERMES_ALERT_EVENTS"; return "${HERMES_FIXTURE_ALERT_RC:-0}"; }',
    'hermes_ok() { printf "recovery %s\\n" "$1" >> "$HERMES_ALERT_EVENTS"; return "${HERMES_FIXTURE_OK_RC:-0}"; }',
    "",
  ].join("\n"), { mode: 0o700 });

  const adapterEnv = {
    HERMES_ALERT_LIBRARY: library,
    HERMES_ALERT_EVENTS: eventsFile,
    HERMES_FIXTURE_ALERT_RC: "1",
  };
  await runAlert({ stateDir, notifier: adapter.pathname, eventsFile, event: "failure", summary: "failure one", extraEnv: adapterEnv });
  await runAlert({ stateDir, notifier: adapter.pathname, eventsFile, event: "failure", summary: "failure two", expectCode: 1, extraEnv: adapterEnv });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_failure/);

  await runAlert({
    stateDir, notifier: adapter.pathname, eventsFile, event: "failure", summary: "retry alert",
    extraEnv: { ...adapterEnv, HERMES_FIXTURE_ALERT_RC: "0" },
  });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=firing/);

  await runAlert({
    stateDir, notifier: adapter.pathname, eventsFile, event: "recovery", summary: "recovery fails",
    expectCode: 1, extraEnv: { ...adapterEnv, HERMES_FIXTURE_ALERT_RC: "0", HERMES_FIXTURE_OK_RC: "1" },
  });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_recovery/);

  await runAlert({
    stateDir, notifier: adapter.pathname, eventsFile, event: "recovery", summary: "retry recovery",
    extraEnv: { ...adapterEnv, HERMES_FIXTURE_ALERT_RC: "0", HERMES_FIXTURE_OK_RC: "0" },
  });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=ok/);
  assert.equal((await events(eventsFile)).match(/^recovery /gm)?.length, 2);
});

test("initializes a persistent user directory and exposes missing notifier or path errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-init-"));
  const stateDir = join(root, "nested", "state");
  const eventsFile = join(stateDir, "events.log");
  const missing = join(root, "missing-notifier");

  await runAlert({ stateDir, notifier: missing, eventsFile, event: "failure", summary: "first failure" });
  await runAlert({ stateDir, notifier: missing, eventsFile, event: "failure", summary: "threshold failure", expectCode: 1 });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_failure/);

  const notDirectory = join(root, "not-a-directory");
  await writeFile(notDirectory, "occupied");
  await runAlert({ stateDir: notDirectory, notifier: missing, eventsFile, event: "failure", summary: "bad directory", expectCode: 1 });
});


test("emits capture marker only on the first threshold crossing", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermes-alert-capture-"));
  const first = await runAlert({ stateDir, event: "failure", summary: "first", threshold: 2 });
  const second = await runAlert({ stateDir, event: "failure", summary: "threshold", threshold: 2 });
  const duplicate = await runAlert({ stateDir, event: "failure", summary: "duplicate", threshold: 2 });
  assert.doesNotMatch(first, /capture=1/);
  assert.match(second, /capture=1/);
  assert.doesNotMatch(duplicate, /capture=1/);
});

test("probes delegate incident capture to the state transition marker", async () => {
  const health = await readFile(new URL("../../infra/observability/health-check.sh", import.meta.url), "utf8");
  const login = await readFile(new URL("../../infra/observability/login-probe.sh", import.meta.url), "utf8");
  for (const source of [health, login]) {
    assert.match(source, /capture=1/);
    assert.equal((source.match(/incident-capture\\.sh/g) || []).length, 1);
  }
});
