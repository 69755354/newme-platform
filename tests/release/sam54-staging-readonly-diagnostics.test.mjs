import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DISK_ALERT_THRESHOLD_PERCENT,
  JOURNAL_WINDOW_MINUTES,
  dispatchSyntheticAlert,
  parseSyntheticAlert,
  runReadOnlyDiagnostic,
} from "../../scripts/verify-staging-sam54-diagnostics.mjs";

const releaseSha = "a".repeat(40);
const releaseRoot = `/opt/newme-staging/releases/${releaseSha}`;
const alertBody = JSON.stringify({
  schemaVersion: 1,
  source: "sam54-staging-uat",
  type: "diagnostic.requested",
  target: "staging",
  reason: "synthetic_acceptance",
  releaseSha,
  marker: "sam54-aaaaaaaaaaaa",
});

function response(status, body) {
  return {
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function successfulOverrides() {
  const calls = [];
  return {
    calls,
    releaseSha,
    now: () => new Date("2026-07-31T00:15:00.000Z"),
    realpath: async (path) => {
      assert.equal(path, "/opt/newme-staging/current");
      return releaseRoot;
    },
    readFile: async (path) => {
      assert.equal(path, `${releaseRoot}/manifest.json`);
      return JSON.stringify({
        git_sha: releaseSha,
        created_at: "2026-07-31T00:00:00.000Z",
      });
    },
    fetch: async (url, options) => {
      calls.push(["fetch", url, options]);
      if (url.endsWith("/api/health")) return response(200, { status: "ok" });
      if (url.endsWith("/api/auth/me")) {
        return response(401, { error: "Unauthorized" });
      }
      throw new Error("unexpected URL");
    },
    execFile: async (command, args, options) => {
      calls.push(["execFile", command, args, options]);
      if (command === "systemctl") return { stdout: "active\n", stderr: "" };
      if (command === "journalctl") {
        return {
          stdout: [
            "request completed status=401",
            "background observation complete",
          ].join("\n"),
          stderr: "",
        };
      }
      if (command === "df") return { stdout: "Use%\n42%\n", stderr: "" };
      if (command === "du") {
        return { stdout: "1048576\t/opt/newme-staging\n", stderr: "" };
      }
      throw new Error("unexpected executable");
    },
  };
}

test("SAM-54 accepts one exact synthetic staging alert envelope", () => {
  assert.deepEqual(parseSyntheticAlert(alertBody, releaseSha), {
    schemaVersion: 1,
    source: "sam54-staging-uat",
    type: "diagnostic.requested",
    target: "staging",
    reason: "synthetic_acceptance",
    releaseSha,
    marker: "sam54-aaaaaaaaaaaa",
  });

  for (const mutation of [
    { target: "production" },
    { releaseSha: "b".repeat(40) },
    { source: "sentry" },
    { extra: true },
  ]) {
    const value = { ...JSON.parse(alertBody), ...mutation };
    assert.throws(
      () => parseSyntheticAlert(JSON.stringify(value), releaseSha),
      /synthetic_alert_contract_mismatch/,
    );
  }
});

test("SAM-54 alert dispatch requires the alert-state key and invokes diagnostics", async () => {
  let invocations = 0;
  const report = await dispatchSyntheticAlert(alertBody, {
    alertKey: "sam54-staging-uat",
    releaseSha,
    async diagnose(options) {
      invocations += 1;
      assert.equal(options.releaseSha, releaseSha);
      return { sentinel: "diagnosed" };
    },
  });
  assert.equal(invocations, 1);
  assert.equal(report.automaticDispatch, true);
  assert.equal(report.trigger.alertKey, "sam54-staging-uat");
  assert.deepEqual(report.checks, { sentinel: "diagnosed" });
  assert.deepEqual(report.safety.fixedExecutables, [
    "systemctl",
    "journalctl",
    "df",
    "du",
  ]);
  assert.equal(report.safety.secretsRead, false);
  assert.equal(report.safety.mutationAttempted, false);
  await assert.rejects(
    dispatchSyntheticAlert(alertBody, {
      alertKey: "manual-controller-bypass",
      releaseSha,
      async diagnose() {
        return {};
      },
    }),
    /alert_state_dispatch_contract_mismatch/,
  );
});

test("SAM-54 collects bounded health, auth, journal, and disk facts without mutation", async () => {
  const overrides = successfulOverrides();
  const checks = await runReadOnlyDiagnostic(overrides);

  assert.deepEqual(checks.service, {
    unit: "newme-staging.service",
    state: "active",
    active: true,
  });
  assert.deepEqual(checks.health, { httpStatus: 200, status: "ok" });
  assert.deepEqual(checks.authMe, { httpStatus: 401 });
  assert.deepEqual(checks.journal, {
    unit: "newme-staging.service",
    windowMinutes: JOURNAL_WINDOW_MINUTES,
    entries: 2,
    unauthorizedMatches: 1,
    errorMatches: 0,
  });
  assert.deepEqual(checks.disk, {
    root: "/opt/newme-staging",
    usedPercent: 42,
    alertThresholdPercent: DISK_ALERT_THRESHOLD_PERCENT,
    overThreshold: false,
    stagingBytes: 1_048_576,
  });

  const executableCalls = overrides.calls
    .filter(([kind]) => kind === "execFile")
    .map(([, command, args]) => [command, args]);
  assert.deepEqual(executableCalls, [
    ["systemctl", ["is-active", "newme-staging.service"]],
    [
      "journalctl",
      [
        "--unit",
        "newme-staging.service",
        "--since",
        "2026-07-31T00:00:00.000Z",
        "--no-pager",
        "--output=cat",
      ],
    ],
    ["df", ["--output=pcent", "/opt/newme-staging"]],
    ["du", ["-sx", "--block-size=1", "/opt/newme-staging"]],
  ]);
});

test("SAM-54 reports unhealthy and over-threshold facts without attempting repair", async () => {
  const overrides = successfulOverrides();
  overrides.fetch = async (url) =>
    url.endsWith("/api/health")
      ? response(503, { status: "degraded" })
      : response(401, { error: "Unauthorized" });
  overrides.execFile = async (command) => {
    if (command === "systemctl") return { stdout: "failed\n", stderr: "" };
    if (command === "journalctl") {
      return { stdout: "401 Unauthorized\nTypeError\n", stderr: "" };
    }
    if (command === "df") return { stdout: "Use%\n91%\n", stderr: "" };
    if (command === "du") return { stdout: "2048\t/opt/newme-staging\n", stderr: "" };
    throw new Error("unexpected executable");
  };

  const checks = await runReadOnlyDiagnostic(overrides);
  assert.equal(checks.service.active, false);
  assert.deepEqual(checks.health, { httpStatus: 503, status: "degraded" });
  assert.equal(checks.journal.unauthorizedMatches, 1);
  assert.equal(checks.journal.errorMatches, 1);
  assert.equal(checks.disk.overThreshold, true);
});

test("SAM-54 source has no secret-file or mutation surface", async () => {
  const source = await readFile(
    new URL("../../scripts/verify-staging-sam54-diagnostics.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /staging\.env|SUPABASE|SENTRY|TOKEN|SECRET/);
  assert.doesNotMatch(
    source,
    /\b(?:exec|spawn|shell|sudo|rm|mv|cp|install|chmod|chown|truncate|kill|systemctl\s+(?:start|stop|restart|reload)|docker|psql)\b/i,
  );
  assert.match(source, /execFile\("systemctl", \["is-active", STAGING_SERVICE\]/);
  assert.match(source, /execFile\("df", \["--output=pcent", STAGING_ROOT\]/);
  assert.match(source, /execFile\("du", \["-sx", "--block-size=1", STAGING_ROOT\]/);
});
