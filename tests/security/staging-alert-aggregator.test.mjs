import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateStagingAlerts,
  sanitizeAlertSummary,
} from "../../infra/observability/staging-alert-aggregator.mjs";

const at = (offset = 0) => new Date(1_700_000_000_000 + offset).toISOString();

test("deduplicates an identical alert for five minutes without collapsing distinct sources", () => {
  const result = aggregateStagingAlerts([
    { source: "health-check", key: "service_down", summary: "status=500", occurredAt: at() },
    { source: "health-check", key: "service_down", summary: "status=500", occurredAt: at(299_999) },
    { source: "login-probe", key: "service_down", summary: "status=500", occurredAt: at(299_999) },
    { source: "health-check", key: "service_down", summary: "status=500", occurredAt: at(300_000) },
  ]);

  assert.equal(result.mode, "dry-run");
  assert.deepEqual(
    result.emitted.map((alert) => [alert.source, alert.key]),
    [["health-check", "service_down"], ["login-probe", "service_down"], ["health-check", "service_down"]],
  );
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, "deduplicated");
});

test("uses supplied state for cross-run deduplication and never exposes secret or PII-like summary content", () => {
  const prior = {
    "health-check:service_down": 1_700_000_000_000,
  };
  const result = aggregateStagingAlerts([
    {
      source: "health-check",
      key: "service_down",
      summary: "email=person@example.com Authorization: Bearer secret-token",
      occurredAt: at(1_000),
    },
  ], prior);

  assert.equal(result.emitted.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(sanitizeAlertSummary("email=person@example.com token=abc123"), "email=[REDACTED] token=[REDACTED]");
});

test("fails closed for unknown sources, invalid timestamps, and send mode", () => {
  assert.throws(
    () => aggregateStagingAlerts([{ source: "unknown", key: "x", summary: "x", occurredAt: at() }]),
    /unsupported alert source/,
  );
  assert.throws(
    () => aggregateStagingAlerts([{ source: "sentry", key: "x", summary: "x", occurredAt: "not-a-date" }]),
    /valid occurredAt/,
  );
  assert.throws(
    () => aggregateStagingAlerts([], {}, { mode: "send" }),
    /dry-run only/,
  );
});
