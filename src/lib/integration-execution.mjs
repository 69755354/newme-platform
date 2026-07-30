const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([100, 250]);

export const INTEGRATION_RUNTIME_POLICIES = Object.freeze({
  meta_oauth: Object.freeze({
    mode: "outbound_http",
    maxAttempts: 3,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retryableHttpStatuses: Object.freeze([408, 429, 500, 502, 503, 504]),
    auditRequired: true,
    alertOnFinalFailure: true,
  }),
  meta_capi: Object.freeze({
    mode: "inbound_webhook",
    maxAttempts: 1,
    timeoutMs: 0,
    retryBoundary: "caller_replay_with_lead_deduplication",
    auditRequired: true,
    alertOnFinalFailure: true,
  }),
  in_app_notification: Object.freeze({
    mode: "database_write",
    maxAttempts: 1,
    timeoutMs: 0,
    retryBoundary: "no_automatic_retry_for_ambiguous_insert",
    auditRequired: true,
    alertOnFinalFailure: true,
  }),
  cron_overdue_installments: Object.freeze({
    mode: "scheduled_database_job",
    maxAttempts: 1,
    timeoutMs: 0,
    retryBoundary: "next_schedule_with_recipient_deduplication",
    auditRequired: true,
    alertOnFinalFailure: true,
  }),
  cron_notification_cleanup: Object.freeze({
    mode: "scheduled_database_job",
    maxAttempts: 1,
    timeoutMs: 0,
    retryBoundary: "next_schedule_after_fail_closed_batch",
    auditRequired: true,
    alertOnFinalFailure: true,
  }),
});

export class IntegrationExecutionError extends Error {
  constructor(code, { retryable = false, status = null, cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "IntegrationExecutionError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export class IntegrationHttpError extends IntegrationExecutionError {
  constructor(status) {
    const retryable = [408, 429, 500, 502, 503, 504].includes(status);
    super(`http_${status}`, { retryable, status });
    this.name = "IntegrationHttpError";
  }
}

function policyFor(integration) {
  const policy = INTEGRATION_RUNTIME_POLICIES[integration];
  if (!policy) throw new IntegrationExecutionError("unknown_integration_policy");
  return policy;
}

function sanitizedReason(error) {
  if (error instanceof IntegrationExecutionError) return error.code;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return "operation_timeout";
  }
  return "operation_failed";
}

function retryableFailure(error) {
  if (error instanceof IntegrationExecutionError) return error.retryable;
  return (
    error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || error instanceof TypeError
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeAudit(audit, event, alert) {
  try {
    await audit(event);
  } catch {
    try {
      await alert({
        integration: event.integration,
        operation: event.operation,
        reason: "audit_sink_failed",
        attempts: event.attempts,
      });
    } catch {
      throw new IntegrationExecutionError("integration_alert_failed");
    }
    throw new IntegrationExecutionError("integration_audit_failed");
  }
}

/**
 * Executes one external integration operation with the repository-owned policy.
 * Callbacks receive only bounded identifiers and status codes; the original
 * error, request body, URL, token, and response body are never passed to audit
 * or alert sinks.
 */
export async function executeBoundedIntegration({
  integration,
  operation,
  execute,
  audit,
  alert,
  sleep = delay,
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
}) {
  const policy = policyFor(integration);
  if (
    typeof operation !== "string"
    || !/^[a-z0-9_.-]+$/.test(operation)
    || typeof execute !== "function"
    || typeof audit !== "function"
    || typeof alert !== "function"
  ) {
    throw new IntegrationExecutionError("invalid_integration_execution_contract");
  }

  let lastError = new IntegrationExecutionError("operation_failed");
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const signal = policy.timeoutMs > 0 ? timeoutSignal(policy.timeoutMs) : undefined;
      const value = await execute({ attempt, signal });
      await writeAudit(
        audit,
        {
          integration,
          operation,
          outcome: "success",
          attempts: attempt,
          reason: null,
        },
        alert,
      );
      return { value, attempts: attempt };
    } catch (error) {
      if (
        error instanceof IntegrationExecutionError
        && ["integration_audit_failed", "integration_alert_failed"].includes(error.code)
      ) {
        throw error;
      }
      lastError = error;
      const reason = sanitizedReason(error);
      const shouldRetry = retryableFailure(error) && attempt < policy.maxAttempts;
      if (shouldRetry) {
        await writeAudit(
          audit,
          {
            integration,
            operation,
            outcome: "retry",
            attempts: attempt,
            reason,
          },
          alert,
        );
        await sleep(DEFAULT_RETRY_DELAYS_MS[attempt - 1] ?? 250);
        continue;
      }

      await writeAudit(
        audit,
        {
          integration,
          operation,
          outcome: "failure",
          attempts: attempt,
          reason,
        },
        alert,
      );
      try {
        await alert({ integration, operation, reason, attempts: attempt });
      } catch {
        throw new IntegrationExecutionError("integration_alert_failed");
      }
      throw new IntegrationExecutionError("integration_operation_failed", {
        cause: lastError,
      });
    }
  }
  throw new IntegrationExecutionError("integration_operation_failed", {
    cause: lastError,
  });
}

export async function integrationFetch({
  integration,
  operation,
  url,
  init = {},
  fetchImpl = globalThis.fetch,
  audit,
  alert,
  sleep = delay,
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
}) {
  const { value, attempts } = await executeBoundedIntegration({
    integration,
    operation,
    audit,
    alert,
    sleep,
    timeoutSignal,
    execute: async ({ signal }) => {
      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch (error) {
        throw new IntegrationExecutionError("network_failure", {
          retryable: true,
          cause: error,
        });
      }
      if (!response.ok) throw new IntegrationHttpError(response.status);
      return response;
    },
  });
  return { response: value, attempts };
}

export function createIntegrationLogSinks({ logger, requestId, route }) {
  if (!logger?.info || !logger?.error) {
    throw new IntegrationExecutionError("invalid_integration_logger");
  }
  return {
    audit(event) {
      logger.info(
        {
          integration_audit: true,
          request_id: requestId,
          route,
          ...event,
        },
        "Integration execution audit",
      );
    },
    alert(event) {
      logger.error(
        {
          integration_alert: true,
          request_id: requestId,
          route,
          ...event,
        },
        "Integration execution final failure",
      );
    },
  };
}
