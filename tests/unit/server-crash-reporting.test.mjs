import assert from "node:assert/strict";
import test from "node:test";
import { installServerCrashReporting } from "../../src/lib/server-crash-reporting.mjs";

function fakeProcess() {
  const handlers = new Map();
  return {
    exitCalls: [],
    once(event, handler) {
      handlers.set(event, handler);
    },
    exit(code) {
      this.exitCalls.push(code);
    },
    handler(event) {
      return handlers.get(event);
    },
  };
}

test("installs one fatal handler and reports then exits non-zero", async () => {
  const runtime = fakeProcess();
  const captured = [];
  const flushed = [];
  const installed = installServerCrashReporting({
    runtime,
    captureException(error, context) {
      captured.push({ error, context });
    },
    flush(timeout) {
      flushed.push(timeout);
      return Promise.resolve(true);
    },
    flushTimeoutMs: 25,
  });

  assert.equal(installed, true);
  assert.equal(installServerCrashReporting({ runtime, captureException() {}, flush() {} }), false);

  const error = new Error("email=person@example.com token=secret-token");
  await runtime.handler("uncaughtException")(error, "uncaughtException");

  assert.equal(captured.length, 1);
  assert.equal(captured[0].error, error);
  assert.deepEqual(captured[0].context, { tags: { crash_origin: "uncaughtException" } });
  assert.deepEqual(flushed, [25]);
  assert.deepEqual(runtime.exitCalls, [1]);
});

test("exits non-zero even when reporting or flush fails", async () => {
  const runtime = fakeProcess();
  installServerCrashReporting({
    runtime,
    captureException() {
      throw new Error("transport failure");
    },
    flush() {
      throw new Error("flush failure");
    },
  });

  await runtime.handler("uncaughtException")(new Error("fatal"));
  assert.deepEqual(runtime.exitCalls, [1]);
});
