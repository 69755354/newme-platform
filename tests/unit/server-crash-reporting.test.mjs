import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { installServerCrashReporting } from "../../src/lib/server-crash-reporting.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadInstrumentation(mocks) {
  const ts = require("typescript");
  const filename = path.join(root, "instrumentation.ts");
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (!Object.hasOwn(mocks, request)) return previousLoad.call(Module, request, parent, isMain);
    const mock = mocks[request];
    return typeof mock === "function" ? mock() : mock;
  };
  try {
    loaded._compile(outputText, filename);
    return {
      instrumentation: loaded.exports,
      restore() {
        Module._load = previousLoad;
      },
    };
  } catch (error) {
    Module._load = previousLoad;
    throw error;
  }
}

function fakeProcess() {
  const handlers = new Map();
  return {
    exitCalls: [],
    registrations: 0,
    on(event, handler) {
      this.registrations += 1;
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

test("Node instrumentation loads existing Sentry server config before registering the crash reporter once", async (t) => {
  const previousRuntime = process.env.NEXT_RUNTIME;
  const events = [];
  const captureException = () => { throw new Error("must not capture during registration"); };
  const flush = () => { throw new Error("must not flush during registration"); };
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previousRuntime;
  });
  process.env.NEXT_RUNTIME = "nodejs";

  const { instrumentation, restore } = loadInstrumentation({
    "@sentry/nextjs": { captureException, flush, captureRequestError: () => {} },
    "./sentry.server.config": () => { events.push("server-config"); return {}; },
    "./src/lib/server-crash-reporting.mjs": {
      installServerCrashReporting(options) {
        events.push("register");
        assert.equal(options.captureException, captureException);
        assert.equal(options.flush, flush);
        return true;
      },
    },
  });

  try {
    await instrumentation.register();
    assert.deepEqual(events, ["server-config", "register"]);
  } finally {
    restore();
  }
});

test("installs one fatal handler, reports through injected Sentry functions, and exits non-zero without logging secrets", async () => {
  const runtime = fakeProcess();
  const captured = [];
  const flushed = [];
  const consoleCalls = [];
  const originalError = console.error;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  console.error = (...args) => consoleCalls.push(args);
  globalThis.fetch = () => { networkCalls += 1; throw new Error("network must not be called"); };
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

  try {
    assert.equal(installed, true);
    assert.equal(installServerCrashReporting({ runtime, captureException() {}, flush() {} }), false);
    assert.equal(runtime.registrations, 1);

    const error = new Error("email=person@example.com token=secret-token");
    await runtime.handler("uncaughtException")(error, "uncaughtException");

    assert.equal(captured.length, 1);
    assert.equal(captured[0].error, error);
    assert.deepEqual(captured[0].context, { tags: { crash_origin: "uncaughtException" } });
    assert.deepEqual(flushed, [25]);
    assert.deepEqual(runtime.exitCalls, [1]);
    assert.equal(networkCalls, 0);
    assert.deepEqual(consoleCalls, []);
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
});

test("exits non-zero when the reporter or flush rejects", async () => {
  const runtime = fakeProcess();
  const flushed = [];
  installServerCrashReporting({
    runtime,
    captureException() {
      return Promise.reject(new Error("transport failure"));
    },
    flush(timeout) {
      flushed.push(timeout);
      return Promise.reject(new Error("flush failure"));
    },
  });

  await runtime.handler("uncaughtException")(new Error("fatal"));
  assert.deepEqual(flushed, [2_000]);
  assert.deepEqual(runtime.exitCalls, [1]);
});

test("bounds a hanging reporter and flush to two seconds or less", async () => {
  const runtime = fakeProcess();
  let cancelled = false;
  installServerCrashReporting({
    runtime,
    captureException() {
      return new Promise(() => {});
    },
    flush() {
      throw new Error("flush must not run after a hung capture");
    },
    flushTimeoutMs: 999_999,
    schedule(resolve, timeout) {
      assert.equal(timeout, 2_000);
      queueMicrotask(resolve);
      return "timer";
    },
    cancel(timer) {
      cancelled = timer === "timer";
    },
  });

  await runtime.handler("uncaughtException")(new Error("fatal"));
  assert.equal(cancelled, true);
  assert.deepEqual(runtime.exitCalls, [1]);
});

test("bounds a hanging flush after a successful reporter", async () => {
  const runtime = fakeProcess();
  let captured = 0;
  installServerCrashReporting({
    runtime,
    captureException() {
      captured += 1;
      return Promise.resolve();
    },
    flush() {
      return new Promise(() => {});
    },
    schedule(resolve, timeout) {
      assert.equal(timeout, 2_000);
      queueMicrotask(resolve);
      return "flush-timer";
    },
    cancel() {},
  });

  await runtime.handler("uncaughtException")(new Error("fatal"));
  assert.equal(captured, 1);
  assert.deepEqual(runtime.exitCalls, [1]);
});

test("recursive fatal handling exits once without invoking the reporter again", async () => {
  const runtime = fakeProcess();
  let reports = 0;
  installServerCrashReporting({
    runtime,
    captureException() {
      reports += 1;
      void runtime.handler("uncaughtException")(new Error("recursive secret-token"));
    },
    flush() {
      return Promise.resolve(true);
    },
  });

  await runtime.handler("uncaughtException")(new Error("fatal"));
  assert.equal(reports, 1);
  assert.deepEqual(runtime.exitCalls, [1]);
});
