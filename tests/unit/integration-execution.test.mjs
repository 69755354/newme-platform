import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGRATION_RUNTIME_POLICIES,
  IntegrationExecutionError,
  IntegrationHttpError,
  executeBoundedIntegration,
} from "../../src/lib/integration-execution.mjs";

const sinks = () => {
  const audits = [];
  const alerts = [];
  return {
    audits,
    alerts,
    audit: async (event) => audits.push(event),
    alert: async (event) => alerts.push(event),
  };
};

test("Meta OAuth retries only within the fixed three-attempt boundary", async () => {
  const events = sinks();
  const sleeps = [];
  let attempts = 0;
  const result = await executeBoundedIntegration({
    integration: "meta_oauth",
    operation: "token_exchange",
    ...events,
    sleep: async (ms) => sleeps.push(ms),
    timeoutSignal: () => new AbortController().signal,
    execute: async ({ attempt, signal }) => {
      attempts += 1;
      assert.equal(attempt, attempts);
      assert.equal(signal instanceof AbortSignal, true);
      if (attempts < 3) throw new IntegrationHttpError(503);
      return "token-response";
    },
  });

  assert.deepEqual(result, { value: "token-response", attempts: 3 });
  assert.deepEqual(sleeps, [100, 250]);
  assert.deepEqual(events.audits.map(({ outcome, attempts: count }) => [outcome, count]), [
    ["retry", 1],
    ["retry", 2],
    ["success", 3],
  ]);
  assert.deepEqual(events.alerts, []);
});

test("non-retryable HTTP failures alert once and never retry", async () => {
  const events = sinks();
  let attempts = 0;
  await assert.rejects(
    executeBoundedIntegration({
      integration: "meta_oauth",
      operation: "token_exchange",
      ...events,
      sleep: async () => assert.fail("must not sleep"),
      timeoutSignal: () => new AbortController().signal,
      execute: async () => {
        attempts += 1;
        throw new IntegrationHttpError(400);
      },
    }),
    (error) => error instanceof IntegrationExecutionError
      && error.code === "integration_operation_failed",
  );
  assert.equal(attempts, 1);
  assert.deepEqual(events.audits.map(({ outcome, reason }) => [outcome, reason]), [
    ["failure", "http_400"],
  ]);
  assert.deepEqual(events.alerts.map(({ reason, attempts: count }) => [reason, count]), [
    ["http_400", 1],
  ]);
});

test("audit and alert sinks fail closed without exposing the original failure", async () => {
  await assert.rejects(
    executeBoundedIntegration({
      integration: "meta_oauth",
      operation: "token_exchange",
      audit: async () => {
        throw new Error("audit database contained secret-value");
      },
      alert: async () => {},
      sleep: async () => {},
      timeoutSignal: () => new AbortController().signal,
      execute: async () => "ok",
    }),
    (error) => error instanceof IntegrationExecutionError
      && error.code === "integration_audit_failed"
      && !error.message.includes("secret-value"),
  );

  await assert.rejects(
    executeBoundedIntegration({
      integration: "meta_oauth",
      operation: "token_exchange",
      audit: async () => {},
      alert: async () => {
        throw new Error("alert destination unavailable");
      },
      sleep: async () => {},
      timeoutSignal: () => new AbortController().signal,
      execute: async () => {
        throw new IntegrationHttpError(400);
      },
    }),
    (error) => error instanceof IntegrationExecutionError
      && error.code === "integration_alert_failed",
  );
});

test("every enabled integration has an explicit retry, audit, and alert disposition", () => {
  assert.deepEqual(Object.keys(INTEGRATION_RUNTIME_POLICIES).sort(), [
    "cron_notification_cleanup",
    "cron_overdue_installments",
    "in_app_notification",
    "meta_capi",
    "meta_oauth",
  ]);
  for (const policy of Object.values(INTEGRATION_RUNTIME_POLICIES)) {
    assert.equal(Number.isInteger(policy.maxAttempts), true);
    assert.equal(policy.maxAttempts >= 1 && policy.maxAttempts <= 3, true);
    assert.equal(policy.auditRequired, true);
    assert.equal(policy.alertOnFinalFailure, true);
  }
  assert.equal(INTEGRATION_RUNTIME_POLICIES.meta_oauth.timeoutMs, 5_000);
  assert.equal(INTEGRATION_RUNTIME_POLICIES.meta_capi.maxAttempts, 1);
  assert.equal(
    INTEGRATION_RUNTIME_POLICIES.in_app_notification.retryBoundary,
    "no_automatic_retry_for_ambiguous_insert",
  );
});
