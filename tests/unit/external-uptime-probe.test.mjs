// S7 item 3: the off-server uptime probe. curl is replaced by a stub on PATH so the
// test runs offline; Telegram calls are recorded instead of sent.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../infra/uptime/external-probe.sh", import.meta.url));

function setup({ login = 200, health = 200, healthBody = '{"status":"ok"}', telegramOk = true, telegramHttp = telegramOk ? 200 : 500 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "newme-uptime-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "state-in.txt"), "");
  const curl = `#!/bin/sh
# stub curl: records telegram sends, serves canned answers for the site
args="$*"
case "$args" in
  *"-K -"*) cat >/dev/null; echo "telegram:$*" >> "${root}/sent.log"
    # like real curl: only --fail turns an HTTP error status into a failing exit code
    case "$args" in *--fail*) [ ${telegramHttp} -ge 400 ] && exit 22;; esac
    exit 0;;
esac
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; https://*) url="$1";; esac; shift; done
case "$url" in
  */login) printf 'login' > "$out"; printf '%s' ${login};;
  */api/health) printf '%s' '${healthBody}' > "$out"; printf '%s' ${health};;
  *) printf '000';;
esac
`;
  writeFileSync(join(root, "bin", "curl"), curl);
  chmodSync(join(root, "bin", "curl"), 0o755);
  writeFileSync(join(root, "env"), "TELEGRAM_BOT_TOKEN=SECRET-TOKEN-VALUE\nTELEGRAM_CHAT_ID=-1001234567890\nFAIL_THRESHOLD=2\nDAILY_HEARTBEAT_HOUR_UTC=3\n");
  const run = (extra = {}) => spawnSync("sh", [script], {
    encoding: "utf8",
    // The clock inputs are fixed (hour 12, a fixed day) so no case depends on when it runs; the
    // fixture's heartbeat hour is 03, which only the heartbeat test selects explicitly.
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, ALERT_CHANNEL: "telegram", UPTIME_ENV_FILE: join(root, "env"), STATE_DIR: join(root, "state"), UPTIME_NOW_HOUR_UTC: "12", UPTIME_TODAY: "2026-11-01", ...extra },
  });
  const sent = () => (existsSync(join(root, "sent.log")) ? readFileSync(join(root, "sent.log"), "utf8").trim().split("\n") : []);
  return { run, sent, root };
}

test("healthy site: exit 0, nothing sent", () => {
  const { run, sent } = setup();
  const r = run({ UPTIME_NOW_HOUR_UTC: "12" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sent(), []);
});

test("alerts once after the threshold, not on the first failure, and recovers with one message", () => {
  const down = setup({ health: 503 });
  assert.equal(down.run().status, 1);
  assert.equal(down.sent().length, 0, "one failed minute is not an alert");
  assert.equal(down.run().status, 1);
  assert.equal(down.sent().length, 1, "second consecutive failure alerts");
  assert.equal(down.run().status, 1);
  assert.equal(down.sent().length, 1, "no repeat while still down");
  // site comes back: swap the stub's answer by re-running with a healthy fixture sharing the same state dir
  const healthy = setup();
  const state = readFileSync(join(down.root, "state", "state"), "utf8");
  mkdirSync(join(healthy.root, "state"), { recursive: true });
  writeFileSync(join(healthy.root, "state", "state"), state);
  assert.equal(healthy.run().status, 0);
  assert.equal(healthy.sent().length, 1, "recovery message");
});

test("wrong health body counts as down; token never reaches argv", () => {
  const { run, sent } = setup({ healthBody: "<html>maintenance</html>" });
  run();
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /content was wrong/);
  assert.equal(sent().length, 1);
  assert.ok(!sent()[0].includes("SECRET-TOKEN-VALUE"), "token is passed on stdin config, not as an argument");
  assert.ok(sent()[0].includes("-1001234567890") || sent()[0].includes("chat_id"));
});

test("a failed Telegram delivery is retried on the next run", () => {
  const { run, sent } = setup({ health: 500, telegramOk: false });
  run();
  const r = run();
  assert.match(r.stderr, /alert not delivered/);
  run();
  assert.equal(sent().length, 2, "retried each run until it is delivered");
});

test("daily heartbeat is sent once per day at the configured hour", () => {
  const { run, sent } = setup();
  run({ UPTIME_NOW_HOUR_UTC: "03", UPTIME_TODAY: "2026-11-05" });
  run({ UPTIME_NOW_HOUR_UTC: "03", UPTIME_TODAY: "2026-11-05" });
  assert.equal(sent().length, 1);
  run({ UPTIME_NOW_HOUR_UTC: "03", UPTIME_TODAY: "2026-11-06" });
  assert.equal(sent().length, 2);
});

test("refuses a non-https base URL", () => {
  const { run } = setup();
  assert.equal(run({ NEWME_BASE_URL: "http://app.newme.ae" }).status, 2);
});

// S17 (Codex review of S7, P2): a Telegram answer such as 401/400 used to count as delivered, so the
// probe stopped retrying and the alert was lost silently.
test("an HTTP error from Telegram is a failed delivery and is retried", () => {
  const { run, sent } = setup({ health: 500, telegramHttp: 400 });
  run();
  const r = run();
  assert.match(r.stderr, /alert not delivered/);
  run();
  assert.equal(sent().length, 2, "retried until Telegram accepts it");
  assert.ok(sent().every((line) => line.includes("--fail")));
});

// S17 B-3: WhatsApp is the default channel; the probe hands events to the shared sender.
test("default channel is the WhatsApp sender: failure, recovery and heartbeat events", () => {
  const down = setup({ health: 503 });
  const sender = join(down.root, "sender.sh");
  writeFileSync(sender, `#!/bin/sh\necho "$1|$2|$3" >> "${down.root}/wa.log"\n`);
  chmodSync(sender, 0o755);
  const env = { ALERT_CHANNEL: "", ALERT_SENDER: sender };
  down.run(env); down.run(env);
  const lines = () => readFileSync(join(down.root, "wa.log"), "utf8").trim().split("\n");
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /^uptime-probe\|failure\|/);
  assert.equal(down.sent().length, 0, "nothing goes to Telegram");
  const healthy = setup();
  mkdirSync(join(healthy.root, "state"), { recursive: true });
  writeFileSync(join(healthy.root, "state", "state"), readFileSync(join(down.root, "state", "state"), "utf8"));
  healthy.run({ ...env, ALERT_SENDER: sender });
  assert.match(lines().at(-1), /^uptime-probe\|recovery\|/);
});

test("a failed WhatsApp send leaves the alert open so the next run retries", () => {
  const f = setup({ health: 503 });
  const sender = join(f.root, "sender.sh");
  writeFileSync(sender, `#!/bin/sh\necho x >> "${f.root}/wa.log"\nexit 1\n`);
  chmodSync(sender, 0o755);
  const env = { ALERT_CHANNEL: "", ALERT_SENDER: sender };
  f.run(env);
  assert.match(f.run(env).stderr, /alert not delivered/);
  f.run(env);
  assert.equal(readFileSync(join(f.root, "wa.log"), "utf8").trim().split("\n").length, 2);
});
