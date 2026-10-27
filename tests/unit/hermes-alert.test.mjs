import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deliverOperationalNotification,
  persistProviderReceiptPair,
} from "../../infra/observability/newme-alert-provider-v1.mjs";

const bashPath = (value) => {
  const path = value instanceof URL ? fileURLToPath(value) : String(value);
  if (process.platform !== "win32") return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
};
const script = bashPath(new URL("../../infra/observability/hermes-alert-state-v1.sh", import.meta.url));

async function runAlert({
  stateDir,
  notifier,
  eventsFile,
  event,
  summary,
  key = "login-probe",
  expectCode = 0,
  threshold,
  extraEnv = {},
}) {
  const env = {
    ...process.env,
    HERMES_ALERT_STATE_DIR: bashPath(stateDir),
    HERMES_ALERT_EVENTS: eventsFile ? bashPath(eventsFile) : "",
    ...Object.fromEntries(Object.entries(extraEnv).map(([key, value]) => [key, bashPath(value)])),
  };
  if (notifier !== undefined) env.HERMES_ALERT_NOTIFIER = bashPath(notifier);
  env.HERMES_L0_ALERT_THRESHOLD = threshold === undefined ? "2" : String(threshold);
  if (threshold !== undefined) env.HERMES_ALERT_THRESHOLD = String(threshold);

  const result = await new Promise((resolve) => {
    const child = spawn("bash", [script, key, event, summary], {
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

const providerFixture = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'if [ "$1" = notify ]; then',
  '  printf "notify %s %s\\n" "$2" "$3" >> "$HERMES_ALERT_EVENTS"',
  "else",
  '  printf "receipt %s %s %s\\n" "$1" "$2" "$NEWME_ALERT_DRILL_TRIGGER_SHA256" >> "$HERMES_ALERT_EVENTS"',
  "fi",
  'case "${HERMES_FIXTURE_PROVIDER_BEHAVIOR:-success}" in',
  "  fail) exit 1 ;;",
  "  noop) exit 0 ;;",
  "  invalid) printf 'not-a-provider-ack\\n'; exit 0 ;;",
  "  success) ;;",
  "  *) exit 2 ;;",
  "esac",
  'message_id="${HERMES_FIXTURE_MESSAGE_ID:-1001}"',
  'if [ "$1" = notify ]; then',
  '  printf "newme-alert-provider-v1 notify %s %s telegram:message:%s\\n" "$2" "$3" "$message_id"',
  "else",
  '  printf "newme-alert-provider-v1 receipt %s %s %s telegram:message:%s\\n" "$1" "$2" "$NEWME_ALERT_DRILL_TRIGGER_SHA256" "$message_id"',
  "fi",
  "",
].join("\n");

async function makeAdapterWithProvider(root, provider) {
  const adapterCopy = join(root, "notifier.sh");
  const adapterSource = await readFile(new URL("../../infra/observability/hermes-alert-notifier-v1.sh", import.meta.url), "utf8");
  await writeFile(
    adapterCopy,
    adapterSource.replace("/opt/hermes-scripts/observability/newme-alert-provider-v1.mjs", bashPath(provider)),
    { mode: 0o700 },
  );
  return adapterCopy;
}

async function events(eventsFile) {
  return readFile(eventsFile, "utf8").catch(() => "");
}

async function runCommand(command, args, env, expectCode = 0) {
  const result = await new Promise((resolve) => {
    const child = spawn("bash", [bashPath(command), ...args], {
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, bashPath(value)])),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, expectCode, result.stderr);
}

test("ordinary adapter notifications use the versioned provider and reject failed or no-op transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-adapter-"));
  const eventsFile = join(root, "events.log");
  const provider = await makeNotifier(root, providerFixture, "provider.sh");
  const adapterCopy = await makeAdapterWithProvider(root, provider);
  const env = { HERMES_ALERT_EVENTS: eventsFile };
  await runCommand(adapterCopy, ["alert", "login-probe", "threshold reached"], env);
  await runCommand(adapterCopy, ["recovery", "login-probe", "probe recovered"], env);
  assert.equal(await events(eventsFile), "notify alert login-probe\nnotify recovery login-probe\n");
  await runCommand(adapterCopy, ["alert", "health-check", "provider failed"], {
    ...env,
    HERMES_FIXTURE_PROVIDER_BEHAVIOR: "fail",
  }, 1);
  await runCommand(adapterCopy, ["alert", "dependency-probe", "provider no-op"], {
    ...env,
    HERMES_FIXTURE_PROVIDER_BEHAVIOR: "noop",
  }, 1);
});

test("ordinary provider validates the exact Telegram delivery without acceptance receipt state", async () => {
  const config = { bot_token: "fixture", chat_id: "-10001", bot_user_id: "20002" };
  const calls = [];
  const now = Math.floor(Date.now() / 1000);
  const request = async (_config, method, body) => {
    calls.push({ method, body });
    if (method === "getMe") return { id: 20002, is_bot: true };
    return { message_id: 30003, chat: { id: -10001 }, from: { id: 20002 }, text: body.text, date: now };
  };
  const result = await deliverOperationalNotification({
    config,
    event: "alert",
    source: "health-check",
    detail: "service unavailable",
    level: "critical",
    request,
  });
  assert.deepEqual(calls.map(({ method }) => method), ["getMe", "sendMessage"]);
  assert.equal(result.providerDeliveryId, "telegram:message:30003");
  assert.match(calls[1].body.text, /^NewMe alert source=health-check level=critical detail=service unavailable$/);
  await assert.rejects(() => deliverOperationalNotification({
    config,
    event: "recovery",
    source: "health-check",
    detail: "recovered",
    level: "critical",
    request: async (_config, method, body) => method === "getMe"
      ? { id: 20002, is_bot: true }
      : { message_id: 30004, chat: { id: -10001 }, from: { id: 20002 }, text: `${body.text} tampered`, date: now },
  }), /provider_delivery_readback_mismatch/);
});

test("postdeploy drill cannot use the legacy five-argument notifier bypass", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-no-bypass-"));
  const provider = await makeNotifier(root, "#!/usr/bin/env bash\nexit 0\n", "provider.sh");
  const adapterCopy = await makeAdapterWithProvider(root, provider);
  await runCommand(
    adapterCopy,
    ["alert", "postdeploy-acceptance-deadbeef", "bypassed state", "failure", "a".repeat(40)],
    {},
    2,
  );
});

test("postdeploy failure and recovery traverse the isolated state machine before provider delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-postdeploy-state-"));
  const stateDir = join(root, "state");
  const eventsFile = join(root, "provider-events.log");
  const provider = await makeNotifier(root, providerFixture, "provider.sh");
  const adapterCopy = await makeAdapterWithProvider(root, provider);

  const releaseSha = "b".repeat(40);
  const failureTriggerSha = "c".repeat(64);
  const recoveryTriggerSha = "d".repeat(64);
  const key = `postdeploy-acceptance-${releaseSha}`;
  const baseEnv = {
    HERMES_ALERT_EVENTS: eventsFile,
    NEWME_ALERT_DRILL_RELEASE_SHA: releaseSha,
  };
  const failure = await runAlert({
    stateDir,
    notifier: adapterCopy,
    eventsFile,
    event: "failure",
    summary: `canonical postdeploy failure; receipt_challenge=${failureTriggerSha}`,
    key,
    threshold: 1,
    extraEnv: {
      ...baseEnv,
      NEWME_ALERT_DRILL_MODE: "failure",
      NEWME_ALERT_DRILL_TRIGGER_SHA256: failureTriggerSha,
      HERMES_FIXTURE_MESSAGE_ID: "1001",
    },
  });
  assert.match(failure, /transition=alert/);
  const recovery = await runAlert({
    stateDir,
    notifier: adapterCopy,
    eventsFile,
    event: "recovery",
    summary: `canonical postdeploy recovery; receipt_challenge=${recoveryTriggerSha}`,
    key,
    threshold: 1,
    extraEnv: {
      ...baseEnv,
      NEWME_ALERT_DRILL_MODE: "recovery",
      NEWME_ALERT_DRILL_TRIGGER_SHA256: recoveryTriggerSha,
      HERMES_FIXTURE_MESSAGE_ID: "1002",
    },
  });
  assert.match(recovery, /transition=recovery/);
  assert.equal(
    await events(eventsFile),
    `receipt failure ${releaseSha} ${failureTriggerSha}\nreceipt recovery ${releaseSha} ${recoveryTriggerSha}\n`,
  );
  const state = await readFile(join(stateDir, `${key}.state`), "utf8");
  assert.equal(state, "status=ok\nfailure_count=0\n");
});

test("provider failure, no output, and a bad ACK cannot make the isolated drill state green", async () => {
  for (const behavior of ["fail", "noop", "invalid"]) {
    const root = await mkdtemp(join(tmpdir(), `hermes-alert-postdeploy-${behavior}-`));
    const stateDir = join(root, "state");
    const eventsFile = join(root, "events.log");
    const provider = await makeNotifier(root, providerFixture, "provider.sh");
    const adapterCopy = await makeAdapterWithProvider(root, provider);
    const releaseSha = "e".repeat(40);
    const triggerSha = "f".repeat(64);
    const key = `postdeploy-acceptance-${releaseSha}`;
    await runAlert({
      stateDir,
      notifier: adapterCopy,
      eventsFile,
      event: "failure",
      summary: `canonical postdeploy failure; receipt_challenge=${triggerSha}`,
      key,
      threshold: 1,
      expectCode: 1,
      extraEnv: {
        HERMES_ALERT_EVENTS: eventsFile,
        HERMES_FIXTURE_PROVIDER_BEHAVIOR: behavior,
        NEWME_ALERT_DRILL_MODE: "failure",
        NEWME_ALERT_DRILL_RELEASE_SHA: releaseSha,
        NEWME_ALERT_DRILL_TRIGGER_SHA256: triggerSha,
      },
    });
    assert.equal(await readFile(join(stateDir, `${key}.state`), "utf8"), "status=pending_failure\nfailure_count=1\n");
  }
});

test("an alert side effect with a lost ACK still requires a confirmed recovery delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-ack-loss-"));
  const stateDir = join(root, "state");
  const eventsFile = join(root, "events.log");
  const provider = await makeNotifier(root, providerFixture, "provider.sh");
  const adapterCopy = await makeAdapterWithProvider(root, provider);
  await runAlert({
    stateDir,
    notifier: adapterCopy,
    eventsFile,
    event: "failure",
    summary: "delivery side effect then ACK loss",
    threshold: 1,
    expectCode: 1,
    extraEnv: { HERMES_ALERT_EVENTS: eventsFile, HERMES_FIXTURE_PROVIDER_BEHAVIOR: "fail" },
  });
  assert.equal(await readFile(join(stateDir, "login-probe.state"), "utf8"), "status=pending_failure\nfailure_count=1\n");
  await runAlert({
    stateDir,
    notifier: adapterCopy,
    eventsFile,
    event: "recovery",
    summary: "confirmed recovery after uncertain alert delivery",
    threshold: 1,
    extraEnv: { HERMES_ALERT_EVENTS: eventsFile, HERMES_FIXTURE_PROVIDER_BEHAVIOR: "success" },
  });
  assert.equal(await readFile(join(stateDir, "login-probe.state"), "utf8"), "status=ok\nfailure_count=0\n");
  assert.equal(await events(eventsFile), "notify alert login-probe\nnotify recovery login-probe\n");
});

test("a body-only provider receipt crash is completed without replacing its body", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-alert-receipt-pair-"));
  const body = Buffer.from('{"receipt":"fixed"}\n');
  const signature = Buffer.from(`${"a".repeat(64)}\n`);
  assert.throws(() => persistProviderReceiptPair(root, "failure", body, signature, {
    afterBodyCommit() { throw new Error("simulated_crash_after_body_commit"); },
  }), /simulated_crash_after_body_commit/);
  assert.equal(await readFile(join(root, "failure.json"), "utf8"), body.toString("utf8"));
  await assert.rejects(() => readFile(join(root, "failure.hmac")), /ENOENT/);
  assert.equal(persistProviderReceiptPair(root, "failure", body, signature), "recovered");
  assert.equal(await readFile(join(root, "failure.hmac"), "utf8"), signature.toString("utf8"));
  assert.equal(persistProviderReceiptPair(root, "failure", body, signature), "existing");
  assert.throws(
    () => persistProviderReceiptPair(root, "failure", Buffer.from('{"receipt":"different"}\n'), signature),
    /provider_receipt_body_conflict/,
  );
});


const recordingNotifier = [
  "#!/usr/bin/env bash",
  'printf "%s %s %s\\n" "$1" "$2" "$3" >> "$HERMES_ALERT_EVENTS"',
  "",
].join("\n");

test("configured threshold two suppresses duplicates, recovers once, and re-alerts later", async () => {
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
  const provider = await makeNotifier(root, providerFixture, "provider.sh");
  const adapterCopy = await makeAdapterWithProvider(root, provider);

  const adapterEnv = {
    HERMES_ALERT_EVENTS: eventsFile,
    HERMES_FIXTURE_PROVIDER_BEHAVIOR: "fail",
  };
  await runAlert({ stateDir, notifier: adapterCopy, eventsFile, event: "failure", summary: "failure one", extraEnv: adapterEnv });
  await runAlert({ stateDir, notifier: adapterCopy, eventsFile, event: "failure", summary: "failure two", expectCode: 1, extraEnv: adapterEnv });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_failure/);

  await runAlert({
    stateDir, notifier: adapterCopy, eventsFile, event: "failure", summary: "retry alert",
    extraEnv: { ...adapterEnv, HERMES_FIXTURE_PROVIDER_BEHAVIOR: "success" },
  });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=firing/);

  await runAlert({
    stateDir, notifier: adapterCopy, eventsFile, event: "recovery", summary: "recovery fails",
    expectCode: 1, extraEnv: { ...adapterEnv, HERMES_FIXTURE_PROVIDER_BEHAVIOR: "fail" },
  });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=pending_recovery/);

  await runAlert({
    stateDir, notifier: adapterCopy, eventsFile, event: "recovery", summary: "retry recovery",
    extraEnv: { ...adapterEnv, HERMES_FIXTURE_PROVIDER_BEHAVIOR: "success" },
  });
  assert.match(await readFile(join(stateDir, "login-probe.state"), "utf8"), /status=ok/);
  assert.equal((await events(eventsFile)).match(/^notify recovery /gm)?.length, 2);
});

test("provider failure, no output, and a bad ACK leave an ordinary probe transition pending", async () => {
  for (const behavior of ["fail", "noop", "invalid"]) {
    const root = await mkdtemp(join(tmpdir(), `hermes-alert-provider-${behavior}-`));
    const stateDir = join(root, "state");
    const eventsFile = join(root, "events.log");
    const provider = await makeNotifier(root, providerFixture, "provider.sh");
    const adapterCopy = await makeAdapterWithProvider(root, provider);
    await runAlert({
      stateDir,
      notifier: adapterCopy,
      eventsFile,
      event: "failure",
      summary: `${behavior} provider`,
      threshold: 1,
      expectCode: 1,
      extraEnv: { HERMES_ALERT_EVENTS: eventsFile, HERMES_FIXTURE_PROVIDER_BEHAVIOR: behavior },
    });
    assert.equal(await readFile(join(stateDir, "login-probe.state"), "utf8"), "status=pending_failure\nfailure_count=1\n");
  }
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
  const notifier = await makeNotifier(stateDir, "#!/usr/bin/env bash\nexit 0\n");
  const first = await runAlert({ stateDir, notifier, event: "failure", summary: "first", threshold: 2 });
  const second = await runAlert({ stateDir, notifier, event: "failure", summary: "threshold", threshold: 2 });
  const duplicate = await runAlert({ stateDir, notifier, event: "failure", summary: "duplicate", threshold: 2 });
  assert.doesNotMatch(first, /capture=1/);
  assert.match(second, /capture=1/);
  assert.doesNotMatch(duplicate, /capture=1/);
});

test("probes delegate incident capture to the state transition marker", async () => {
  const health = await readFile(new URL("../../infra/observability/health-check.sh", import.meta.url), "utf8");
  const login = await readFile(new URL("../../infra/observability/login-probe.sh", import.meta.url), "utf8");
  const dependency = await readFile(new URL("../../infra/observability/dependency-probe.sh", import.meta.url), "utf8");
  for (const source of [health, login, dependency]) {
    assert.match(source, /capture=1/);
    assert.equal((source.match(/incident-capture\.sh/g) || []).length, 1);
  }
});

test("L0 probes alert on the first failed check", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hermes-alert-l0-"));
  const eventsFile = join(stateDir, "events.log");
  const notifier = await makeNotifier(stateDir, recordingNotifier);
  const output = await runAlert({
    stateDir,
    notifier,
    eventsFile,
    event: "failure",
    summary: "first L0 failure",
    threshold: 1,
  });
  assert.match(output, /transition=alert/);
  assert.equal((await events(eventsFile)).match(/^alert /gm)?.length, 1);
});
