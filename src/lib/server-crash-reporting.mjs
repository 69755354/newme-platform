const INSTALL_KEY = Symbol.for("newme.serverCrashReporting.installed");
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

function boundedTimeout(value) {
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), 1), DEFAULT_FLUSH_TIMEOUT_MS)
    : DEFAULT_FLUSH_TIMEOUT_MS;
}

async function settleWithin(operation, timeoutMs, schedule, cancel) {
  let timer;
  const settledOperation = Promise.resolve()
    .then(operation)
    .catch(() => undefined);
  const timeout = new Promise((resolve) => {
    timer = schedule(resolve, timeoutMs);
  });

  try {
    await Promise.race([settledOperation, timeout]);
  } finally {
    if (timer !== undefined) cancel(timer);
  }
}

/**
 * @param {{
 *   runtime?: NodeJS.Process;
 *   captureException?: (error: unknown, context: { tags: Record<string, string> }) => void;
 *   flush?: (timeout: number) => unknown;
 *   flushTimeoutMs?: number;
 *   schedule?: typeof setTimeout;
 *   cancel?: typeof clearTimeout;
 * }} options
 */
export function installServerCrashReporting({
  runtime = process,
  captureException,
  flush,
  flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!runtime || typeof runtime.on !== "function" || typeof runtime.exit !== "function") {
    return false;
  }
  if (runtime[INSTALL_KEY]) return false;

  runtime[INSTALL_KEY] = true;
  let handling = false;
  let exiting = false;
  const timeoutMs = boundedTimeout(flushTimeoutMs);

  const exitFatal = () => {
    if (!exiting) {
      exiting = true;
      runtime.exit(1);
    }
  };

  runtime.on("uncaughtException", async (error, origin = "uncaughtException") => {
    if (handling) {
      exitFatal();
      return;
    }
    handling = true;

    const report = async () => {
      if (typeof captureException === "function") {
        try {
          await Promise.resolve(captureException(error, { tags: { crash_origin: origin } }));
        } catch {
          // Continue to flush the existing reporting pipeline after a reporter failure.
        }
      }
      if (typeof flush === "function") {
        try {
          await Promise.resolve(flush(timeoutMs));
        } catch {
          // Fatal exit is intentionally unchanged when the reporter rejects.
        }
      }
    };

    try {
      await settleWithin(report, timeoutMs, schedule, cancel);
    } finally {
      exitFatal();
    }
  });
  return true;
}
