import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// S14: a request cut short by navigation, unmount or abort must not log a console
// error or raise an error message; a real failure must still do both. The post-deploy
// browser acceptance fails a release on ANY console error (the dashboard's aborted
// summary request did exactly that), so the rule lives in one helper and every client
// catch goes through it.
import {
  isAbortError,
  isInterruptedFetch,
  isNetworkFetchFailure,
  isPageLeaving,
  logFetchFailure,
  onFetchFailure,
} from "../../src/lib/fetch-interruption.ts";

const window_ = new EventTarget();
globalThis.window = window_;
const leave = () => window_.dispatchEvent(new Event("pagehide"));
const stay = () => window_.dispatchEvent(new Event("pageshow"));
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 5));

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}
function failedToFetch() {
  return new TypeError("Failed to fetch");
}

function captureConsole(t) {
  const calls = [];
  const original = { error: console.error, warn: console.warn };
  console.error = (...args) => calls.push(["error", ...args]);
  console.warn = (...args) => calls.push(["warn", ...args]);
  t.after(() => Object.assign(console, original));
  return calls;
}

test("classification: AbortError in every shape the app can see", () => {
  assert.equal(isAbortError(abortError()), true);
  assert.equal(isAbortError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  // supabase-js wraps a fetch rejection as a plain result error with this message
  assert.equal(isAbortError({ message: "AbortError: signal is aborted without reason" }), true);
  assert.equal(isAbortError(new Error("HTTP 500")), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError(null), false);
});

test("classification: only the browser's own fetch failure counts as network-type", () => {
  assert.equal(isNetworkFetchFailure(failedToFetch()), true);
  assert.equal(isNetworkFetchFailure(new TypeError("Load failed")), true);
  assert.equal(isNetworkFetchFailure(new TypeError("NetworkError when attempting to fetch resource.")), true);
  assert.equal(isNetworkFetchFailure({ message: "TypeError: Failed to fetch", details: "stack", code: "" }), true);
  const authRetry = Object.assign(new Error("Failed to fetch"), { name: "AuthRetryableFetchError" });
  assert.equal(isNetworkFetchFailure(authRetry), true);
  // the app throwing new Error("Failed to fetch") for a non-OK response is a real failure
  assert.equal(isNetworkFetchFailure(new Error("Failed to fetch")), false);
  assert.equal(isNetworkFetchFailure(new TypeError("Cannot read properties of undefined")), false);
  assert.equal(isNetworkFetchFailure(abortError()), false);
  assert.equal(isNetworkFetchFailure(undefined), false);
});

test("interrupted: aborted signal, AbortError, and network failure after unmount or while leaving", () => {
  stay();
  const controller = new AbortController();
  assert.equal(isInterruptedFetch(new Error("anything"), { signal: controller.signal }), false);
  controller.abort();
  assert.equal(isInterruptedFetch(new Error("anything"), { signal: controller.signal }), true);

  assert.equal(isInterruptedFetch(abortError()), true);

  assert.equal(isInterruptedFetch(failedToFetch(), { isActive: () => true }), false);
  assert.equal(isInterruptedFetch(failedToFetch(), { isActive: () => false }), true);

  leave();
  assert.equal(isPageLeaving(), true);
  assert.equal(isInterruptedFetch(failedToFetch()), true);
  // A genuine server failure is never swallowed just because the page is going away.
  assert.equal(isInterruptedFetch(new Error("HTTP 500")), false);
  stay();
  assert.equal(isPageLeaving(), false);
  assert.equal(isInterruptedFetch(failedToFetch()), false);
});

test("an unmounted component still reports a real server failure", () => {
  assert.equal(isInterruptedFetch(new Error("HTTP 500"), { isActive: () => false }), false);
});

test("onFetchFailure: aborted and page-leaving requests run no handler", async () => {
  stay();
  let ran = 0;
  const controller = new AbortController();
  controller.abort();
  onFetchFailure(new Error("HTTP 500"), () => { ran += 1; }, { signal: controller.signal });
  onFetchFailure(abortError(), () => { ran += 1; });
  onFetchFailure(failedToFetch(), () => { ran += 1; }, { isActive: () => false });
  leave();
  onFetchFailure(failedToFetch(), () => { ran += 1; });
  await nextTask();
  assert.equal(ran, 0);
  stay();
});

test("onFetchFailure: a real failure runs the handler, immediately unless it is network-type", async () => {
  stay();
  const seen = [];
  onFetchFailure(new Error("HTTP 500"), () => seen.push("http"));
  onFetchFailure(undefined, () => seen.push("no-error-object"));
  assert.deepEqual(seen, ["http", "no-error-object"]);
  onFetchFailure(failedToFetch(), () => seen.push("offline"));
  assert.deepEqual(seen, ["http", "no-error-object"], "a network-type failure is reported one task later");
  await nextTask();
  assert.deepEqual(seen, ["http", "no-error-object", "offline"]);
});

test("onFetchFailure: a network-type failure is dropped when the page starts leaving before the deferred report", async () => {
  stay();
  let ran = 0;
  onFetchFailure(failedToFetch(), () => { ran += 1; });
  leave(); // the document is being replaced right after the failure arrives
  await nextTask();
  assert.equal(ran, 0);
  stay();
});

test("logFetchFailure: console.error for real failures only", async (t) => {
  stay();
  const calls = captureConsole(t);
  const controller = new AbortController();
  controller.abort();
  logFetchFailure("[x] aborted", abortError(), { signal: controller.signal });
  logFetchFailure("[x] cut short", failedToFetch(), { isActive: () => false });
  logFetchFailure("[x] http", new Error("HTTP 500"));
  logFetchFailure("[x] offline", failedToFetch());
  await nextTask();
  assert.deepEqual(calls.map((call) => call[1]), ["[x] http", "[x] offline"]);
  assert.ok(calls.every((call) => call[0] === "error"));
});

// ---------------------------------------------------------------------------
// Source guard: no client code logs a fetch failure on its own.
// ---------------------------------------------------------------------------

const SRC = new URL("../../src", import.meta.url).pathname;

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) yield full;
  }
}

/**
 * console.error/warn calls in client files that are NOT about an interruptible
 * request. Each entry says why it is exempt; anything new must go through
 * onFetchFailure/logFetchFailure (src/lib/fetch-interruption.ts) or be added here
 * with a reason.
 */
const EXEMPT = new Map([
  ["components/error-boundary.tsx", "React render error boundary, not a request"],
  ["components/DashboardErrorBoundary.tsx", "React render error boundary, not a request"],
  ["app/error.tsx", "Next.js route error boundary, not a request"],
  ["lib/mutation-feedback.ts", "user-initiated writes; transport failures are classified 'network' and are not logged there"],
  ["app/(dashboard)/leads/_hooks/useLeadMutations.ts", "logs an HTTP status the server answered with, not a transport failure"],
  ["app/(dashboard)/leads/[id]/useLeadDetailMutations.ts", "logs an HTTP status or a classified mutation kind the server answered with"],
]);

test("every client console.error/warn about a request goes through the interruption helper", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/^(?:\s*\/\/[^\n]*\n)*\s*["']use client["']/.test(text.slice(0, 400))) continue;
    const relative = path.relative(SRC, file).split(path.sep).join("/");
    if (EXEMPT.has(relative)) continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!/console\.(?:error|warn)\(/.test(line)) return;
      const context = lines.slice(Math.max(0, index - 4), index + 1).join("\n");
      if (/\b(?:onFetchFailure|logFetchFailure)\(/.test(context)) return;
      offenders.push(`${relative}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [], "wrap these in onFetchFailure/logFetchFailure, or exempt them with a reason");
});

test("no client file hand-rolls its own AbortError check", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    if (file.endsWith("lib/fetch-interruption.ts")) continue;
    const text = readFileSync(file, "utf8");
    if (/\.name\s*===\s*["']AbortError["']/.test(text)) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, [], "use isAbortError / onFetchFailure from src/lib/fetch-interruption.ts");
});

test("the dashboard summary request is silenced through the helper with its own signal", () => {
  const page = readFileSync(path.join(SRC, "app/(dashboard)/dashboard/page.tsx"), "utf8");
  assert.match(page, /onFetchFailure\(err, \(\) => \{[\s\S]*?console\.error\("\[dashboard\] summary fetch failed:", err\)[\s\S]*?\}, \{ signal: controller\.signal \}\)/);
});
