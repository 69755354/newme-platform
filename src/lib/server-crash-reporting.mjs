const INSTALL_KEY = Symbol.for("newme.serverCrashReporting.installed");
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * @param {{
 *   runtime?: NodeJS.Process;
 *   captureException?: (error: unknown, context: { tags: Record<string, string> }) => void;
 *   flush?: (timeout: number) => unknown;
 *   flushTimeoutMs?: number;
 * }} options
 */
export function installServerCrashReporting({
  runtime = process,
  captureException,
  flush,
  flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
} = {}) {
  if (!runtime || typeof runtime.once !== "function" || typeof runtime.exit !== "function") {
    return false;
  }
  if (runtime[INSTALL_KEY]) return false;

  runtime[INSTALL_KEY] = true;
  runtime.once("uncaughtException", async (error, origin = "uncaughtException") => {
    try {
      if (typeof captureException === "function") {
        captureException(error, { tags: { crash_origin: origin } });
      }
      if (typeof flush === "function") {
        await Promise.resolve(flush(flushTimeoutMs));
      }
    } catch {
      // Reporting must not change the fatal-exit path.
    }

    runtime.exit(1);
  });
  return true;
}
