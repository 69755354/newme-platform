// S17 B-3: operational alerts go out as WhatsApp Business Cloud API template messages. A local HTTP
// server stands in for graph.facebook.com so the real curl, the real status checks and the real
// state file are exercised. Phone numbers and tokens below are obvious fakes.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../infra/alerts/newme-whatsapp-alert.sh", import.meta.url));
const TOKEN = "FAKE-ACCESS-TOKEN-VALUE";

async function fixture({ status = 200, body = '{"messages":[{"id":"wamid.X"}]}', perRecipient } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* recorded as null */ }
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: parsed });
      const code = perRecipient ? perRecipient(parsed?.to) : status;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(code >= 400 ? '{"error":{"message":"template not approved","code":132001}}' : body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = mkdtempSync(join(tmpdir(), "newme-wa-"));
  const env = {
    PATH: process.env.PATH, HOME: root,
    ALERT_ENV_FILE: join(root, "none.env"),
    ALERT_WHATSAPP_API_BASE: `http://127.0.0.1:${server.address().port}`,
    ALERT_WHATSAPP_ACCESS_TOKEN: TOKEN,
    ALERT_WHATSAPP_PHONE_NUMBER_ID: "100200300",
    ALERT_WHATSAPP_RECIPIENTS: "+15550000001, 15550000002",
    ALERT_STATE_DIR: join(root, "state"),
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
  const f = await fixture({ status: 401, body: "{}" });
  const r = await f.run(["k", "failure", "x"], { ALERT_CHANNEL: "telegram", TELEGRAM_BOT_TOKEN: "FAKE-TG", TELEGRAM_CHAT_ID: "-1", ALERT_TELEGRAM_API_BASE: f.env.ALERT_WHATSAPP_API_BASE });
  assert.equal(r.status, 1);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /^\/botFAKE-TG\/sendMessage/);
  f.close();
});

test("the sender passes shellcheck when it is installed", () => {
  const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return;
  const r = spawnSync("shellcheck", ["-s", "sh", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});
