// S17 B-3: operational alerts go out as WhatsApp Business Cloud API template messages. A local HTTP
// server stands in for graph.facebook.com so the real curl, the real status checks and the real
// state file are exercised. Phone numbers and tokens below are obvious fakes.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../infra/alerts/newme-whatsapp-alert.sh", import.meta.url));
const TOKEN = "FAKE-ACCESS-TOKEN-VALUE";

const TG_TOKEN = "123456789:FAKEbotTOKENvalueABCDEFGHIJ";
function providerFile(root, mode = 0o600, extra = {}) {
  const file = join(root, "provider.json");
  writeFileSync(file, JSON.stringify({ provider_version: "newme-alert-provider-telegram/v1", bot_token: TG_TOKEN, chat_id: -1001234567890, bot_user_id: 123456789, ...extra }));
  chmodSync(file, mode);
  return file;
}

async function fixture({ status = 200, body = '{"messages":[{"id":"wamid.X"}]}', perRecipient, tgStatus = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* recorded as null */ }
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: parsed, raw });
      if (req.url.startsWith("/bot")) {
        res.writeHead(tgStatus, { "content-type": "application/json" });
        res.end(tgStatus === 200 ? '{"ok":true,"result":{"message_id":7}}' : '{"ok":false,"error_code":401,"description":"Unauthorized"}');
        return;
      }
      const code = perRecipient ? perRecipient(parsed?.to) : status;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(code >= 400 ? '{"error":{"message":"template not approved","code":132001}}' : body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const root = mkdtempSync(join(tmpdir(), "newme-wa-"));
  const env = {
    PATH: process.env.PATH, HOME: root,
    ALERT_ENV_FILE: join(root, "none.env"),
    ALERT_WHATSAPP_API_BASE: `http://127.0.0.1:${server.address().port}`,
    ALERT_WHATSAPP_ACCESS_TOKEN: TOKEN,
    ALERT_WHATSAPP_PHONE_NUMBER_ID: "100200300",
    ALERT_WHATSAPP_RECIPIENTS: "+15550000001, 15550000002",
    ALERT_STATE_DIR: join(root, "state"),
    // Never the host's real provider file: tests that want the fallback write their own.
    ALERT_TELEGRAM_PROVIDER_CONFIG: join(root, "no-provider.json"),
    ALERT_TELEGRAM_API_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  const run = (args, extra = {}) => new Promise((resolve) => {
    execFile("sh", [script, ...args], { env: { ...env, ...extra }, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
  return { run, requests, root, env, close: () => server.close() };
}

test("a failure alert is one approved-template message to every recipient, with the token only in a header", async () => {
  const f = await fixture();
  const r = await f.run(["db-backup", "failure", "database backup failed (exit 1)"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map((x) => x.body.to), ["15550000001", "15550000002"], "plus sign and spaces are normalised");
  const first = f.requests[0];
  assert.equal(first.method, "POST");
  assert.equal(first.url, "/v26.0/100200300/messages");
  assert.equal(first.auth, `Bearer ${TOKEN}`);
  assert.equal(first.body.messaging_product, "whatsapp");
  assert.equal(first.body.type, "template");
  assert.equal(first.body.template.name, "newme_ops_alert");
  assert.equal(first.body.template.language.code, "zh_CN");
  const params = first.body.template.components[0].parameters.map((p) => p.text);
  assert.deepEqual(params, ["故障", "db-backup", "database backup failed (exit 1)"]);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), "token never printed");
  f.close();
});

test("template parameters are single-line and quotes survive", async () => {
  const f = await fixture();
  const r = await f.run(["k", "failure", 'line one\nline "two"\t\t   end \\ done']);
  assert.equal(r.status, 0, r.stderr);
  const text = f.requests[0].body.template.components[0].parameters[2].text;
  assert.equal(text, 'line one line "two" end \\ done');
  f.close();
});

test("HTTP errors are not delivery: exit 1, local log line, no state written, retried next time", async () => {
  const f = await fixture({ status: 400 });
  const r = await f.run(["db-backup", "failure", "boom"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTP 400/);
  assert.match(r.stderr, /132001/, "Meta's error code is surfaced");
  const log = readFileSync(join(f.env.ALERT_STATE_DIR, "alerts.log"), "utf8");
  assert.match(log, /db-backup failure .*FAILED/);
  assert.ok(!existsSync(join(f.env.ALERT_STATE_DIR, "db-backup.state")), "a failed send does not count as alerted");
  f.close();
});

test("a 200 answer without a message id is still a failure", async () => {
  const f = await fixture({ body: "{}" });
  const r = await f.run(["k", "failure", "x"]);
  assert.equal(r.status, 1);
  f.close();
});

test("one recipient failing makes the whole call fail but the others are still tried", async () => {
  const f = await fixture({ perRecipient: (to) => (to === "15550000001" ? 500 : 200) });
  const r = await f.run(["k", "failure", "x"]);
  assert.equal(r.status, 1);
  assert.equal(f.requests.length, 2);
  f.close();
});

test("unreachable API is a failure with a log line, not silence", async () => {
  const f = await fixture();
  f.close();
  const r = await f.run(["k", "failure", "x"]);
  assert.equal(r.status, 1);
  assert.match(readFileSync(join(f.env.ALERT_STATE_DIR, "alerts.log"), "utf8"), /FAILED/);
});

test("repeat failures are suppressed for ALERT_REPEAT_HOURS, then recovery is sent once", async () => {
  const f = await fixture();
  assert.equal((await f.run(["freshness", "failure", "stale"])).status, 0);
  assert.equal(f.requests.length, 2);
  assert.equal((await f.run(["freshness", "failure", "stale"])).status, 0);
  assert.equal(f.requests.length, 2, "second failure inside the window sends nothing");
  assert.equal((await f.run(["freshness", "recovery", "fresh again"])).status, 0);
  assert.equal(f.requests.length, 4, "recovery goes to both recipients");
  assert.equal(f.requests[2].body.template.components[0].parameters[0].text, "恢复");
  assert.equal((await f.run(["freshness", "recovery", "fresh again"])).status, 0);
  assert.equal(f.requests.length, 4, "recovery without an open alert sends nothing");
  f.close();
});

test("info always sends and keeps no state", async () => {
  const f = await fixture();
  await f.run(["probe", "info", "alive"]);
  await f.run(["probe", "info", "alive"]);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[0].body.template.components[0].parameters[0].text, "通知");
  f.close();
});

test("configuration problems exit 2 and say what is missing without printing values", async () => {
  const f = await fixture();
  for (const [name, value] of [["ALERT_WHATSAPP_ACCESS_TOKEN", ""], ["ALERT_WHATSAPP_PHONE_NUMBER_ID", ""], ["ALERT_WHATSAPP_RECIPIENTS", ""], ["ALERT_WHATSAPP_RECIPIENTS", "not-a-number"]]) {
    const r = await f.run(["k", "failure", "x"], { [name]: value });
    assert.equal(r.status, 2, name);
    assert.ok(!r.stderr.includes(TOKEN));
  }
  assert.equal((await f.run(["k", "bogus", "x"])).status, 2);
  assert.equal((await f.run(["bad key!", "failure", "x"])).status, 2);
  assert.equal(f.requests.length, 0);
  f.close();
});

test("the API base must be https unless it is the loopback address", () => {
  const r = spawnSync("sh", [script, "k", "failure", "x"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ALERT_ENV_FILE: "/nonexistent", ALERT_WHATSAPP_API_BASE: "http://example.com", ALERT_WHATSAPP_ACCESS_TOKEN: "t", ALERT_WHATSAPP_PHONE_NUMBER_ID: "1", ALERT_WHATSAPP_RECIPIENTS: "15550000001", ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "wa-")) },
  });
  assert.equal(r.status, 2);
});

test("an env file readable by others is refused", async () => {
  const f = await fixture();
  const file = join(f.root, "alerts.env");
  writeFileSync(file, `ALERT_WHATSAPP_ACCESS_TOKEN=${TOKEN}\n`);
  chmodSync(file, 0o644);
  const r = await f.run(["k", "failure", "x"], { ALERT_ENV_FILE: file });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mode/);
  chmodSync(file, 0o600);
  writeFileSync(file, `ALERT_WHATSAPP_ACCESS_TOKEN=${TOKEN}\nALERT_WHATSAPP_PHONE_NUMBER_ID=100200300\nALERT_WHATSAPP_RECIPIENTS=15550000009\n`);
  const ok = await f.run(["k", "failure", "x"], { ALERT_ENV_FILE: file, ALERT_WHATSAPP_ACCESS_TOKEN: "", ALERT_WHATSAPP_PHONE_NUMBER_ID: "", ALERT_WHATSAPP_RECIPIENTS: "" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(f.requests[0].body.to, "15550000009");
  f.close();
});

test("Telegram stays available as an option and also checks the HTTP status", async () => {
  const f = await fixture({ tgStatus: 401 });
  const r = await f.run(["k", "failure", "x"], { ALERT_CHANNEL: "telegram", TELEGRAM_BOT_TOKEN: "FAKE-TG", TELEGRAM_CHAT_ID: "-1" });
  assert.equal(r.status, 1);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /^\/botFAKE-TG\/sendMessage/);
  f.close();
});

test("long Chinese summaries are cut at a character boundary and the JSON stays valid", async () => {
  const f = await fixture();
  for (const summary of ["数据库备份失败".repeat(120), `a${"备份".repeat(300)}`, `ab${"备份".repeat(300)}`]) {
    const r = await f.run(["k", "info", summary]);
    assert.equal(r.status, 0, r.stderr);
    const body = f.requests.at(-1).body;
    assert.ok(body !== null, "request body is valid JSON");
    const text = body.template.components[0].parameters[2].text;
    assert.ok(!text.includes("\uFFFD"), "no broken character");
    assert.ok(text.length > 100 && text.length <= 400, `length ${text.length}`);
    assert.ok(summary.startsWith(text), "a clean prefix of the original");
  }
  f.close();
});

test("an unwritable state directory falls back to another one, so repeats are still suppressed", async () => {
  const f = await fixture();
  const locked = join(f.root, "locked"); writeFileSync(locked, "a file, so nothing can be created below it (even as root)");
  const fb = join(f.root, "fallback");
  const extra = { ALERT_STATE_DIR: join(locked, "state"), ALERT_FALLBACK_DIRS: fb };
  const first = await f.run(["watch", "failure", "stale"], extra);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /fallback/);
  assert.equal(f.requests.length, 2);
  const second = await f.run(["watch", "failure", "stale"], extra);
  assert.equal(second.status, 0);
  assert.equal(f.requests.length, 2, "no second message a minute later");
  f.close();
});

test("with no usable state directory at all the alert is sent once, exits 1 and says why", async () => {
  const f = await fixture();
  const locked = join(f.root, "locked"); writeFileSync(locked, "a file, so nothing can be created below it (even as root)");
  const extra = { ALERT_STATE_DIR: join(locked, "a"), ALERT_FALLBACK_DIRS: join(locked, "b") };
  const r = await f.run(["watch", "failure", "stale"], extra);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no writable state directory/);
  assert.equal(f.requests.length, 2, "delivered once to each recipient");
  f.close();
});

// ---- Telegram fallback (audit 2026-11-20 F1: the WhatsApp template did not exist, so no alert ever arrived) ----
test("WhatsApp 404 falls back to the release gate's Telegram bot: exit 0, both outcomes logged, nothing secret printed", async () => {
  const f = await fixture({ status: 404 });
  const provider = providerFile(f.root);
  const r = await f.run(["db-backup", "failure", "database backup failed"], { ALERT_TELEGRAM_PROVIDER_CONFIG: provider });
  assert.equal(r.status, 0, r.stderr);
  const tg = f.requests.filter((x) => x.url.startsWith("/bot"));
  assert.equal(f.requests.length - tg.length, 2, "both WhatsApp recipients were tried first");
  assert.equal(tg.length, 1);
  assert.equal(tg[0].url, `/bot${TG_TOKEN}/sendMessage`);
  const form = new URLSearchParams(tg[0].raw);
  assert.equal(form.get("chat_id"), "-1001234567890");
  assert.match(form.get("text"), /^\[故障\] db-backup: database backup failed .*Telegram 备用/);
  const log = readFileSync(join(f.env.ALERT_STATE_DIR, "alerts.log"), "utf8");
  assert.match(log, /db-backup failure FAILED HTTP 404/);
  assert.match(log, /db-backup failure delivered via telegram \(fallback\) HTTP 200/);
  assert.match(r.stderr, /FAILED: HTTP 404/, "the WhatsApp failure is still visible in the journal");
  assert.ok(existsSync(join(f.env.ALERT_STATE_DIR, "db-backup.state")), "a fallback delivery counts as alerted");
  for (const out of [r.stdout, r.stderr, log]) assert.ok(!out.includes(TG_TOKEN) && !out.includes(TOKEN));
  f.close();
});

test("one WhatsApp recipient failing also sends the Telegram copy", async () => {
  const f = await fixture({ perRecipient: (to) => (to === "15550000001" ? 500 : 200) });
  const r = await f.run(["k", "failure", "x"], { ALERT_TELEGRAM_PROVIDER_CONFIG: providerFile(f.root) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.filter((x) => x.url.startsWith("/bot")).length, 1);
  f.close();
});

test("WhatsApp delivered: Telegram is not used", async () => {
  const f = await fixture();
  const r = await f.run(["k", "failure", "x"], { ALERT_TELEGRAM_PROVIDER_CONFIG: providerFile(f.root) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.filter((x) => x.url.startsWith("/bot")).length, 0);
  f.close();
});

test("WhatsApp not configured at all still alerts through Telegram (the 11-13..11-18 'token is not set' gap)", async () => {
  const f = await fixture();
  const r = await f.run(["k", "failure", "x"], { ALERT_WHATSAPP_ACCESS_TOKEN: "", ALERT_TELEGRAM_PROVIDER_CONFIG: providerFile(f.root, 0o400) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].url.startsWith("/bot"));
  assert.match(readFileSync(join(f.env.ALERT_STATE_DIR, "alerts.log"), "utf8"), /FAILED whatsapp not configured: ALERT_WHATSAPP_ACCESS_TOKEN is not set/);
  f.close();
});

test("explicit TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID win over the provider file", async () => {
  const f = await fixture({ status: 404 });
  const r = await f.run(["k", "failure", "x"], { ALERT_TELEGRAM_PROVIDER_CONFIG: providerFile(f.root), TELEGRAM_BOT_TOKEN: "42:explicit", TELEGRAM_CHAT_ID: "-5" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.at(-1).url, "/bot42:explicit/sendMessage");
  f.close();
});

test("both channels failing exits 1 and logs both failures", async () => {
  const f = await fixture({ status: 404, tgStatus: 401 });
  const r = await f.run(["k", "failure", "x"], { ALERT_TELEGRAM_PROVIDER_CONFIG: providerFile(f.root) });
  assert.equal(r.status, 1);
  const log = readFileSync(join(f.env.ALERT_STATE_DIR, "alerts.log"), "utf8");
  assert.match(log, /FAILED HTTP 404/);
  assert.match(log, /FAILED telegram \(fallback\) HTTP 401/);
  assert.ok(!existsSync(join(f.env.ALERT_STATE_DIR, "k.state")));
  f.close();
});

test("a provider file others can read, or with the wrong shape, is not used as a fallback", async () => {
  for (const [mode, extra] of [[0o644, {}], [0o600, { provider_version: "other" }], [0o600, { bot_token: "nope" }]]) {
    const f = await fixture({ status: 404 });
    const r = await f.run(["k", "failure", "x"], { ALERT_TELEGRAM_PROVIDER_CONFIG: providerFile(f.root, mode, extra) });
    assert.equal(r.status, 1, `mode ${mode.toString(8)} ${JSON.stringify(extra)}`);
    assert.equal(f.requests.filter((x) => x.url.startsWith("/bot")).length, 0);
    assert.match(readFileSync(join(f.env.ALERT_STATE_DIR, "alerts.log"), "utf8"), /FAILED no Telegram fallback/);
    assert.ok(!r.stderr.includes(TG_TOKEN));
    f.close();
  }
});

test("WhatsApp misconfigured and no Telegram fallback is a configuration error naming both", async () => {
  const f = await fixture();
  const r = await f.run(["k", "failure", "x"], { ALERT_WHATSAPP_PHONE_NUMBER_ID: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /PHONE_NUMBER_ID is not set; Telegram fallback unavailable: telegram is not configured/);
  f.close();
});

test("the sender passes shellcheck when it is installed", () => {
  const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return;
  const r = spawnSync("shellcheck", ["-s", "sh", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});
