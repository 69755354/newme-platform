// S13: tests/unit/external-uptime-probe.test.mjs failed in the 03:xx UTC hour (the hour its
// fixture uses for the daily heartbeat) because most cases never fixed the probe's clock, so a
// heartbeat message was added to the counts. This runs that file with a `date` that always
// reports the heartbeat hour and checks it still passes, so it can no longer depend on the clock.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("./external-uptime-probe.test.mjs", import.meta.url));

test("external uptime probe tests pass even when the clock is at the heartbeat hour", () => {
  const bin = mkdtempSync(join(tmpdir(), "newme-fake-date-"));
  writeFileSync(join(bin, "date"), `#!/bin/sh
case "$*" in
  *+%H*) echo 03;;
  *+%Y-%m-%d*) echo 2026-11-07;;
  *) exec /usr/bin/date "$@";;
esac
`);
  chmodSync(join(bin, "date"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT; // otherwise the nested runner reports to the outer one and its exit code is lost
  const r = spawnSync(process.execPath, ["--test", target], { encoding: "utf8", env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
