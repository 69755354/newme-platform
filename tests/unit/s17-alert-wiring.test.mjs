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

test("daily production check: failure -> failure event, pass -> recovery only, pass note on request", async () => {
  const s = fakeSender();
  const env = { ALERT_SENDER: s.file, PATH: process.env.PATH };
  assert.equal(await sendAlert(env, "FAILED", false), true);
  assert.equal(await sendAlert(env, "PASSED", true), true);
  assert.equal(await sendAlert({ ...env, SYNTH_NOTIFY_PASS: "1" }, "PASSED", true), true);
  assert.deepEqual(s.calls(), ["synthetic-journey|failure|FAILED", "synthetic-journey|recovery|PASSED", "synthetic-journey|info|PASSED"]);
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
