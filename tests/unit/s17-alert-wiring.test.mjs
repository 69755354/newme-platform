// S17 B-3: every S7 alert path defaults to the WhatsApp sender and can still be pointed elsewhere.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sendAlert } from "../../scripts/synthetic-journey.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SENDER = "/usr/local/libexec/newme/newme-whatsapp-alert.sh";

test("the L0 watchdog alerts through the WhatsApp sender by default", () => {
  assert.ok(readFileSync(join(root, "infra/observability/l0-watchdog.sh"), "utf8").includes(SENDER));
});

function fakeSender(exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "newme-sj-"));
  const file = join(dir, "sender.sh");
  writeFileSync(file, `#!/bin/sh\necho "$1|$2|$3" >> "${dir}/calls"\nexit ${exit}\n`);
  chmodSync(file, 0o755);
  return { file, calls: () => { try { return readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch { return []; } } };
}

test("daily check: failure -> failure event, pass -> recovery only; keys are per environment (production / staging)", async () => {
  const s = fakeSender();
  const env = { ALERT_SENDER: s.file, PATH: process.env.PATH };
  assert.equal(await sendAlert(env, "FAILED", false), true);
  assert.equal(await sendAlert(env, "PASSED", true), true);
  assert.equal(await sendAlert({ ...env, SYNTH_MODE: "staging" }, "FAILED", false), true);
  assert.equal(await sendAlert({ ...env, SYNTH_MODE: "staging" }, "PASSED", true), true);
  assert.deepEqual(s.calls(), [
    "synthetic-journey-production|failure|FAILED", "synthetic-journey-production|recovery|PASSED",
    "synthetic-journey-staging|failure|FAILED", "synthetic-journey-staging|recovery|PASSED",
  ]);
});

test("SYNTH_NOTIFY_PASS=1 closes the open incident first, then sends the optional info", async () => {
  const s = fakeSender();
  assert.equal(await sendAlert({ ALERT_SENDER: s.file, PATH: process.env.PATH, SYNTH_NOTIFY_PASS: "1" }, "PASSED", true), true);
  assert.deepEqual(s.calls(), ["synthetic-journey-production|recovery|PASSED", "synthetic-journey-production|info|PASSED"]);
});

test("with the real sender, failure -> pass(+info) -> failure alerts twice, and staging never touches production's incident", async () => {
  // The sender is run with spawnSync, which blocks this process, so the fake WhatsApp API must live in its own process.
  const { spawn } = await import("node:child_process");
  const { mkdtempSync: mk, readFileSync: rd, existsSync: ex } = await import("node:fs");
  const dirTmp = mkdtempSync(join(tmpdir(), "newme-sj-api-"));
  const countFile = join(dirTmp, "count");
  const api = spawn(process.execPath, ["-e", `
    const http=require("http"),fs=require("fs");let n=0;
    const s=http.createServer((q,r)=>{q.resume();q.on("end",()=>{n++;fs.writeFileSync(${JSON.stringify(countFile)},String(n));r.writeHead(200,{"content-type":"application/json"});r.end('{"messages":[{"id":"x"}]}');});});
    s.listen(0,"127.0.0.1",()=>console.log(s.address().port));`], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => api.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  const hits = { get length() { return ex(countFile) ? Number(rd(countFile, "utf8")) : 0; } };
  const dir = mk(join(tmpdir(), "newme-sj-real-"));
  const env = { PATH: process.env.PATH, ALERT_SENDER: join(root, "infra/alerts/newme-whatsapp-alert.sh"), ALERT_ENV_FILE: join(dir, "none"), ALERT_STATE_DIR: join(dir, "state"),
    ALERT_WHATSAPP_API_BASE: `http://127.0.0.1:${port}`, ALERT_WHATSAPP_ACCESS_TOKEN: "t", ALERT_WHATSAPP_PHONE_NUMBER_ID: "1", ALERT_WHATSAPP_RECIPIENTS: "15550000001", SYNTH_NOTIFY_PASS: "1" };
  await sendAlert(env, "FAILED", false); const afterFirst = hits.length;
  await sendAlert({ ...env, SYNTH_MODE: "staging" }, "PASSED", true);          // staging pass must not close production
  await sendAlert(env, "FAILED", false);
  assert.equal(hits.length, afterFirst + 1, "only staging's own info went out; production's second failure is still suppressed");
  await sendAlert(env, "PASSED", true);                                         // production recovers (+info)
  const before = hits.length;
  await sendAlert(env, "FAILED", false);
  assert.equal(hits.length, before + 1, "a new outage after a pass alerts again");
  api.kill();
});

test("a sender that fails is reported as undelivered, never as success", async () => {
  const s = fakeSender(1);
  assert.equal(await sendAlert({ ALERT_SENDER: s.file, PATH: process.env.PATH }, "FAILED", false), false);
  assert.equal(await sendAlert({ ALERT_SENDER: "/nonexistent/sender", PATH: process.env.PATH }, "FAILED", false), false);
});

test("the alert scripts shipped for S7 do not call Telegram directly except as the optional channel", () => {
  for (const f of ["infra/backup/newme-db-backup.sh", "infra/backup/newme-backup-freshness.sh", "infra/backup/newme-restore-drill.sh", "infra/observability/l0-watchdog.sh", "infra/cron/newme-cron-call.sh"]) {
    assert.ok(!/api\.telegram\.org/.test(readFileSync(join(root, f), "utf8")), f);
  }
  const probe = spawnSync("grep", ["-c", "ALERT_CHANNEL", join(root, "infra/uptime/external-probe.sh")], { encoding: "utf8" });
  assert.ok(Number(probe.stdout) >= 2);
});

test("every sandboxed unit that sends alerts has a writable, persistent state directory", () => {
  const sandboxed = ["infra/uptime/newme-uptime.service", "infra/cron/newme-cron@.service", "infra/alerts/newme-unit-alert@.service", "infra/backup/newme-db-backup.service", "infra/backup/newme-backup-freshness.service", "infra/backup/newme-restore-drill.service", "infra/backup/newme-backup-alert@.service"];
  for (const f of sandboxed) {
    const text = readFileSync(join(root, f), "utf8");
    const rw = [...text.matchAll(/^ReadWritePaths=(.*)$/gm)].flatMap((m) => m[1].split(/\s+/)).map((p) => p.replace(/^-/, ""));
    const strict = /^ProtectSystem=strict$/m.test(text);
    const envDir = text.match(/^Environment=ALERT_STATE_DIR=(\S+)$/m)?.[1];
    const stateDir = envDir ?? "/var/lib/newme-alerts";
    if (strict) assert.ok(rw.some((p) => stateDir === p || stateDir.startsWith(`${p}/`)), `${f}: ${stateDir} must be writable`);
    // PrivateTmp hides /tmp between runs, so state must not depend on the /tmp fallback
    assert.ok(!stateDir.startsWith("/tmp"), f);
  }
  assert.match(readFileSync(join(root, "infra/uptime/newme-uptime.service"), "utf8"), /^Environment=ALERT_STATE_DIR=\/var\/lib\/newme-uptime\/alerts$/m);
});
