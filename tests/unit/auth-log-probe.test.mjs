import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("../../infra/observability/auth-log-probe.py", import.meta.url));
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function run(log, extraArgs = []) {
  return spawnSync(
    "python3",
    [script, "--log", log, "--now", "2026-08-08T10:00:00Z", "--window-seconds", "600", ...extraArgs],
    { cwd: root, encoding: "utf8" },
  );
}

test("auth access-log probe detects recent login-boundary 5xx", () => {
  const dir = mkdtempSync(join(tmpdir(), "newme-auth-log-probe-"));
  const log = join(dir, "access.log");
  writeFileSync(log, [
    '127.0.0.1 - - [08/Aug/2026:09:55:00 +0000] "GET /api/auth/me HTTP/2.0" 500 12 "-" "test"',
    '127.0.0.1 - - [08/Aug/2026:09:56:00 +0000] "POST /api/auth/session HTTP/2.0" 502 12 "-" "test"',
    '127.0.0.1 - - [08/Aug/2026:09:57:00 +0000] "GET /api/auth/me HTTP/2.0" 401 12 "-" "test"',
    '127.0.0.1 - - [08/Aug/2026:09:58:00 +0000] "GET /api/health HTTP/2.0" 500 12 "-" "test"',
    '127.0.0.1 - - [08/Aug/2026:09:40:00 +0000] "GET /api/auth/me HTTP/2.0" 500 12 "-" "test"',
    "",
  ].join("\n"));

  const result = run(log);
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "auth_failures");
  assert.equal(payload.auth_failures, 2);
  assert.equal(payload.auth_5xx, 2);
  assert.equal(payload.auth_429, 0);
  assert.deepEqual(payload.paths, { "/api/auth/me": 1, "/api/auth/session": 1, "/login": 0 });
});

test("auth access-log probe treats shared-proxy 429 responses as login failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "newme-auth-log-rate-limit-"));
  const log = join(dir, "access.log");
  writeFileSync(log, [
    '172.64.1.1 - - [08/Aug/2026:09:58:00 +0000] "GET /login HTTP/2.0" 429 12 "-" "test"',
    '172.64.1.1 - - [08/Aug/2026:09:59:00 +0000] "POST /api/auth/session HTTP/2.0" 429 12 "-" "test"',
    "",
  ].join("\n"));

  const result = run(log);
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.auth_failures, 2);
  assert.equal(payload.auth_429, 2);
  assert.equal(payload.auth_5xx, 0);
  assert.deepEqual(payload.status_codes, { 429: 2 });
});

test("auth access-log probe is green for bounded auth responses", () => {
  const dir = mkdtempSync(join(tmpdir(), "newme-auth-log-clean-"));
  const log = join(dir, "access.log");
  writeFileSync(
    log,
    '127.0.0.1 - - [08/Aug/2026:09:59:00 +0000] "GET /api/auth/me HTTP/2.0" 401 12 "-" "test"\n',
  );

  const result = run(log);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).auth_5xx, 0);
  assert.equal(JSON.parse(result.stdout).auth_429, 0);
});

test("auth access-log probe fails closed when its log is unavailable", () => {
  const missing = join(tmpdir(), `newme-auth-log-missing-${process.pid}-${Date.now()}`);
  const result = run(missing);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).status, "probe_error");
});

test("composite monitor runs the login boundary probe every two minutes", () => {
  const loginProbe = read("infra/observability/login-probe.sh");
  const composite = read("infra/observability/l0-composite-probe.sh");
  const cron = read("infra/observability/newme-observability.cron");
  const installer = read("scripts/install-systemd-assets.sh");

  assert.match(loginProbe, /Origin: \$\{SITE_ORIGIN\}/);
  assert.match(loginProbe, /SESSION_CODE.*!= "400"/s);
  assert.match(loginProbe, /auth-log-probe\.py/);
  assert.match(loginProbe, /AUTH_LOG_STATUS/);
  assert.match(loginProbe, /429\/5xx/);
  assert.match(composite, /LOGIN_PROBE=.*login-probe\.sh/);
  assert.match(cron, /^\*\/2 .*l0-composite-probe\.sh$/m);
  assert.doesNotMatch(cron, /^\*\/2 .*login-probe\.sh$/m);
  assert.match(installer, /auth-log-probe\.py/);
  assert.match(installer, /l0-composite-probe\.sh/);
});
