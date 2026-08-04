import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const script = join(repoRoot, "infra/systemd/newme-service-control.sh");
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";

test("service control binds allowed actions to the one production unit", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /\[ "\$#" -eq 2 \] \|\| usage/);
  assert.match(source, /restart\|reset-failed/);
  assert.match(source, /only newme-platform\.service can be controlled/);
  assert.match(source, /exec \/usr\/bin\/systemctl "\$action" newme-platform\.service/);
  assert.doesNotMatch(source, /start\|stop|try-restart/);
});

test("service control rejects arity, direct actions, and unit-shaped reasons", () => {
  const cases = [
    [],
    ["restart"],
    ["restart", "deploy:test", "extra"],
    ["start", "deploy:test"],
    ["stop", "deploy:test"],
    ["try-restart", "deploy:test"],
    ["restart", "newme-platform.service"],
    ["restart", "probe.socket"],
    ["reset-failed", "nightly.timer"],
  ];

  for (const args of cases) {
    const result = spawnSync(bash, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
  }
});
