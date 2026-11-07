/**
 * One place that decides whether a failed browser request is a real failure or
 * just a request that was cut short because the user moved on.
 *
 * Why this exists: a full-page navigation (or a route change, or an unmounted
 * component) cancels requests that are still in flight. Chromium reports that to
 * script as `TypeError: Failed to fetch` -- not an `AbortError` -- so every
 * `catch` that logged with `console.error` or raised a toast produced a bogus
 * error on the page being left. The post-deploy browser acceptance fails a
 * release on any console error, and the dashboard's summary request tripped it.
 *
 * Rules (all callers share them; do not copy this logic into components):
 *  - the request's own `AbortSignal` is aborted            -> interrupted, always
 *  - an `AbortError` (also the Supabase client's wrapped
 *    "AbortError: ..." message)                            -> interrupted
 *  - a network-type failure (`Failed to fetch`, Safari's
 *    `Load failed`, Firefox's `NetworkError ...`) while the
 *    component is gone or the page is being unloaded       -> interrupted
 *  - anything else (HTTP 4xx/5xx wrapped in an Error, a real
 *    offline `Failed to fetch` on a page that stays open,
 *    bad JSON, ...)                                        -> a REAL failure: logged and
 *                                                             shown exactly as before.
 *
 * A network-type failure on a live, mounted page is reported one task later
 * rather than immediately: when the document is being replaced, the failure
 * arrives while it is still alive but a task later it is gone, so the deferred
 * report never runs. `pagehide` additionally marks the page as leaving for the
 * cases where the task does still run.
 */

export type FetchInterruptionContext = {
  /** The AbortSignal handed to `fetch`, if the caller has one. */
  signal?: AbortSignal | null;
  /** False once the owning component/effect is gone (a `cancelled`/`mounted` flag). */
  isActive?: () => boolean;
};

const NETWORK_FETCH_MESSAGE =
  /^(?:failed to fetch|load failed|network ?error when attempting to fetch resource\.?|the network connection was lost\.?|network request failed)$/i;
/** The Supabase client reports a dropped fetch as a plain "TypeError: Failed to fetch" message. */
const WRAPPED_TYPE_ERROR = /^TypeError: ?/;
/** Error classes whose message is the browser's own fetch failure text. */
const FETCH_ERROR_NAMES = new Set(["TypeError", "AuthRetryableFetchError"]);

/** How long a `beforeunload` is trusted if the user cancels the navigation. */
const BEFORE_UNLOAD_WINDOW_MS = 3000;

let pageLeaving = false;
let listening = false;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function ensureListeners(): void {
  if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  listening = true;
  window.addEventListener("pagehide", () => {
    pageLeaving = true;
  });
  window.addEventListener("pageshow", () => {
    pageLeaving = false;
  });
  window.addEventListener("beforeunload", () => {
    pageLeaving = true;
    if (clearTimer) clearTimeout(clearTimer);
    // The user may stay on the page; do not silence real failures for ever.
    clearTimer = setTimeout(() => {
      pageLeaving = false;
    }, BEFORE_UNLOAD_WINDOW_MS);
  });
}

ensureListeners();

/** True from the moment the browser starts unloading this document. */
export function isPageLeaving(): boolean {
  ensureListeners();
  return pageLeaving;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

/** `AbortError`, as thrown by fetch/AbortController or wrapped by the Supabase client. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return /^AbortError\b/.test(messageOf(error));
  const named = (error as { name?: unknown }).name;
  if (named === "AbortError") return true;
  return /^AbortError\b/.test(messageOf(error));
}

/** The browser's "the request never completed" failure, in any engine's wording. */
export function isNetworkFetchFailure(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const message = messageOf(error).trim();
  if (WRAPPED_TYPE_ERROR.test(message)) return NETWORK_FETCH_MESSAGE.test(message.replace(WRAPPED_TYPE_ERROR, ""));
  const named = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  // `new Error("Failed to fetch")` is the app reporting a non-OK response, not the browser
  // reporting a cancelled request: only the browser's own error classes count.
  return typeof named === "string" && FETCH_ERROR_NAMES.has(named) && NETWORK_FETCH_MESSAGE.test(message);
}

function inactive(context: FetchInterruptionContext): boolean {
  return context.isActive ? !context.isActive() : false;
}

/**
 * True when `error` is the echo of a request that was interrupted rather than a
 * failure worth reporting. Pure given the page state at the time of the call.
 */
export function isInterruptedFetch(error: unknown, context: FetchInterruptionContext = {}): boolean {
  if (context.signal?.aborted) return true;
  if (isAbortError(error)) return true;
  if (isNetworkFetchFailure(error)) return inactive(context) || isPageLeaving();
  return false;
}

/**
 * Run `handler` (log, toast, set an error state) only for a real failure.
 * Interrupted requests are dropped silently. A network-type failure on a page
 * that is still alive is handled one task later, re-checked at that point.
 */
export function onFetchFailure(error: unknown, handler: () => void, context: FetchInterruptionContext = {}): void {
  if (isInterruptedFetch(error, context)) return;
  if (!isNetworkFetchFailure(error)) {
    handler();
    return;
  }
  setTimeout(() => {
    if (isInterruptedFetch(error, context)) return;
    handler();
  }, 0);
}

/** `console.error(label, error)` for real failures only. */
export function logFetchFailure(label: string, error: unknown, context: FetchInterruptionContext = {}): void {
  onFetchFailure(error, () => console.error(label, error), context);
}
