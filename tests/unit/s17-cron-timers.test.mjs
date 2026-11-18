// S17 B-1: the application has scheduled endpoints under src/app/api/cron/. Production had timers for
// none of them. These checks keep the systemd units, the schedule table and the route directory in step.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const schedule = JSON.parse(read("infra/cron/schedule.json"));
const routes = readdirSync(join(root, "src/app/api/cron"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const INSTALL = new Set(["enable", "after-flag", "hermes-owned", "route-disabled"]);

test("every cron route is in the schedule table and every table row is a route", () => {
  assert.deepEqual(schedule.endpoints.map((e) => e.name).sort(), routes);
  for (const e of schedule.endpoints) assert.ok(INSTALL.has(e.install), `${e.name} install value`);
});

test("every cron route has a timer whose time matches the Dubai design and which starts the one shared service", () => {
  for (const e of schedule.endpoints) {
    const file = `infra/cron/newme-cron-${e.name}.timer`;
    assert.ok(existsSync(join(root, file)), `${file} exists`);
    const text = read(file);
    assert.match(text, new RegExp(`^OnCalendar=\\*-\\*-\\* ${e.dubaiTime}:00 Asia/Dubai$`, "m"), `${e.name} fires at ${e.dubaiTime} Dubai`);
    assert.match(text, new RegExp(`^Unit=newme-cron@${e.name}\\.service$`, "m"));
    assert.match(text, /^Persistent=true$/m);
    assert.match(text, new RegExp(`^# STATUS: ${e.install}$`, "m"), `${e.name} says why it is or is not installed`);
  }
});

test("only the timers that are meant to run are marked enable; the two Hermes endpoints are not duplicated", () => {
  const enabled = schedule.endpoints.filter((e) => e.install === "enable").map((e) => e.name).sort();
  assert.deepEqual(enabled, ["check-no-answer", "daily-funnel-snapshot", "daily-reminder"]);
  for (const name of ["check-overdue-installments", "cleanup-notifications"]) {
    const e = schedule.endpoints.find((x) => x.name === name);
    assert.equal(e.install, "hermes-owned");
    assert.equal(e.dubaiTime, "09:02", "same slot as Hermes, so a takeover changes nothing for users");
    assert.equal(e.idempotent, true);
  }
});

test("routes scheduled to run daily are idempotent; disabled routes really are disabled in code", () => {
  for (const e of schedule.endpoints.filter((x) => x.install === "enable")) assert.equal(e.idempotent, true, e.name);
  for (const e of schedule.endpoints.filter((x) => x.install === "route-disabled")) {
    assert.match(read(`src/app/api/cron/${e.name}/route.ts`), /Disabled/, `${e.name} route must still answer Disabled (else give it a real timer)`);
  }
  assert.equal(schedule.endpoints.find((e) => e.name === "daily-digest").idempotent, false);
});

test("every cron route authenticates with x-cron-secret", () => {
  for (const name of routes) {
    const src = read(`src/app/api/cron/${name}/route.ts`);
    if (/Disabled/.test(src) && !/CRON_SECRET/.test(src)) continue; // disabled stubs do nothing
    assert.match(src, /x-cron-secret/, name);
    assert.match(src, /CRON_SECRET/, name);
  }
});

test("the shared service is hardened but can still read its env file and write its state", () => {
  const unit = read("infra/cron/newme-cron@.service");
  for (const line of ["NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=true", "ProtectKernelTunables=true", "RestrictSUIDSGID=true", "LockPersonality=true", "PrivateDevices=true"]) {
    assert.ok(unit.includes(line), line);
  }
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/libexec\/newme\/newme-cron-call\.sh %i$/m);
  assert.match(unit, /^OnFailure=newme-unit-alert@%p-%i\.service$/m);
  // ProtectHome hides /home, /root and /run/user: nothing the unit reads or writes may live there.
  for (const m of unit.matchAll(/^(?:EnvironmentFile|ReadWritePaths|ExecStart)=-?(\S+)/gm)) {
    assert.ok(!/^\/(home|root|run\/user)\b/.test(m[1]), `${m[1]} is hidden by ProtectHome`);
  }
  assert.match(unit, /^EnvironmentFile=\/etc\/newme\/cron\.env$/m);
  assert.match(unit, /^ReadWritePaths=-?\/var\/lib\/newme-alerts/m);
  assert.doesNotMatch(unit, /newme-runtime\.env/, "the unit gets the cron secret only, not the application's service keys");
});

test("systemd-analyze accepts the units when it is available", () => {
  if (spawnSync("systemd-analyze", ["--version"]).status !== 0) return;
  for (const e of schedule.endpoints) {
    const r = spawnSync("systemd-analyze", ["calendar", `*-*-* ${e.dubaiTime}:00 Asia/Dubai`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});

// --- behaviour of the shared caller script against a local server -------------------------------------
const script = join(root, "infra/cron/newme-cron-call.sh");
async function fixture(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, method: req.method, secret: req.headers["x-cron-secret"] }); handler(req, res, seen.length); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "newme-cron-"));
  const alerts = join(dir, "alerts.log");
  const sender = join(dir, "sender.sh");
  writeFileSync(sender, `#!/bin/sh\necho "$1 $2 $3" >> "${alerts}"\n`);
  chmodSync(sender, 0o755);
  const run = (args, extra = {}) => new Promise((resolve) => {
    execFile("sh", [script, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CRON_SECRET: "unit-test-secret", NEWME_CRON_BASE_URL: `http://127.0.0.1:${port}`, ALERT_SENDER: sender, NEWME_CRON_RETRY_DELAY: "0", ...extra },
    }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
  });
  return { run, seen, alerts: () => (existsSync(alerts) ? readFileSync(alerts, "utf8").trim().split("\n") : []), close: () => server.close() };
}

test("cron caller: success is exit 0, sends the secret as a header, logs the status, and closes any open alert", async () => {
  const f = await fixture((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"checked":3}'); });
  const r = await f.run(["daily-reminder"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.seen.map((s) => [s.method, s.url, s.secret]), [["GET", "/api/cron/daily-reminder", "unit-test-secret"]]);
  assert.match(r.stdout, /HTTP 200/);
  assert.ok(!r.stdout.includes("unit-test-secret") && !r.stderr.includes("unit-test-secret"));
  assert.deepEqual(f.alerts(), ["newme-cron-daily-reminder recovery newme-cron daily-reminder is healthy again"]);
  f.close();
});

test("cron caller: a 4xx/5xx answer is a failure (exit 1) even though curl itself connected", async () => {
  for (const code of [401, 403, 500, 502]) {
    const f = await fixture((_q, res) => { res.writeHead(code); res.end('{"error":"x"}'); });
    const r = await f.run(["check-no-answer"]);
    assert.equal(r.status, 1, `HTTP ${code}`);
    assert.match(r.stderr, new RegExp(`HTTP ${code}`));
    assert.deepEqual(f.alerts(), [], "the failure alert is raised by the unit's OnFailure, once");
    f.close();
  }
});

test("cron caller: an endpoint that answers Disabled is reported (exit 4), not silently counted as success", async () => {
  const f = await fixture((_q, res) => { res.writeHead(200); res.end('{"message":"Disabled","reason":"x"}'); });
  const r = await f.run(["daily-digest"]);
  assert.equal(r.status, 4);
  f.close();
});

test("cron caller: connection refused is retried, other failures are not", async () => {
  const f = await fixture(() => {});
  f.close();
  const r = await f.run(["daily-reminder"], { NEWME_CRON_RETRIES: "3" });
  assert.equal(r.status, 1);
  assert.equal((r.stderr.match(/attempt \d/g) ?? []).length, 3);
  let hits = 0;
  const g = await fixture((_q, res) => { hits += 1; res.writeHead(500); res.end("{}"); });
  await g.run(["daily-reminder"], { NEWME_CRON_RETRIES: "3" });
  assert.equal(hits, 1, "a 500 is never retried: the write may have happened");
  g.close();
});

test("cron caller: bad names, missing secret and bad URL are configuration errors (exit 2)", async () => {
  const f = await fixture((_q, res) => { res.writeHead(200); res.end("{}"); });
  assert.equal((await f.run(["../etc/passwd"])).status, 2);
  assert.equal((await f.run([])).status, 2);
  assert.equal((await f.run(["daily-reminder"], { CRON_SECRET: "" })).status, 2);
  assert.equal((await f.run(["daily-reminder"], { CRON_SECRET: 'a"b' })).status, 2);
  assert.equal((await f.run(["daily-reminder"], { NEWME_CRON_BASE_URL: "http://example.com" })).status, 2);
  assert.equal(f.seen.length, 0);
  f.close();
});

test("cron scripts pass shellcheck when it is installed", () => {
  if (spawnSync("shellcheck", ["--version"]).status !== 0) return;
  const r = spawnSync("shellcheck", ["-s", "sh", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});
