// S15 D-1: in production mode the S9 global setup skipped the session-cache branch (which
// is where the browser used to be started), so `browser!.newContext` threw
// "Cannot read properties of null". The browser must be started before the first login.
//
// This file replaces the module loader for one load, so scripts/run-node-tests.mjs
// runs it in its own process.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request)
    ? mocks[request]
    : previousLoad.call(Module, request, parent, isMain));
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

const ROLES = ["admin", "boss"];

async function runSetup({ isProduction }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s15-global-setup-"));
  const events = [];
  const page = {
    goto: async () => {},
    waitForFunction: async () => {},
    locator: () => ({ first: () => ({ fill: async () => {}, click: async () => {} }), innerText: async () => "" }),
    waitForURL: async () => {},
    url: () => "https://app.example.test/dashboard",
    waitForLoadState: async () => {},
  };
  const browser = {
    newContext: async () => {
      events.push("newContext");
      return { route: async () => {}, newPage: async () => page, storageState: async ({ path: file }) => { fs.writeFileSync(file, "{}"); }, close: async () => {} };
    },
    close: async () => { events.push("close"); },
  };
  const setup = loadModule("e2e/regression/global-setup.ts", {
    "@playwright/test": { chromium: { launch: async () => { events.push("launch"); return browser; } } },
    "./lib/accounts.mjs": {
      loadAccounts: () => Object.fromEntries(ROLES.map((r) => [r, { email: `${r}@x.test`, password: "not a secret" }])),
      missingRoles: () => [],
      ROLE_KEYS: ROLES,
    },
    "./lib/target.mjs": {
      resolveTarget: () => ({ baseURL: "https://app.example.test", isProduction, suite: "smoke", runId: "r1", accountsFile: "x" }),
      isMetaTraffic: () => false,
      publicOriginFor: () => null,
    },
    "./lib/paths": { authStatePath: (_base, key) => path.join(dir, `${key}.json`), authCacheDir: () => path.join(dir, "cache") },
  });
  const realFetch = globalThis.fetch;
  const previousRunDir = process.env.E2E_RUN_DIR;
  const previousLog = console.log;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  process.env.E2E_RUN_DIR = path.join(dir, "run");
  console.log = () => {};
  try {
    await setup.default({ projects: [{ use: {} }] });
  } finally {
    globalThis.fetch = realFetch;
    console.log = previousLog;
    if (previousRunDir === undefined) delete process.env.E2E_RUN_DIR; else process.env.E2E_RUN_DIR = previousRunDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return events;
}

test("production mode starts the browser before the first login and closes it afterwards", async () => {
  const events = await runSetup({ isProduction: true });
  assert.deepEqual(events, ["launch", "newContext", "newContext", "close"]);
});

test("non-production mode still starts exactly one browser", async () => {
  const events = await runSetup({ isProduction: false });
  assert.equal(events.filter((e) => e === "launch").length, 1);
  assert.ok(events.indexOf("launch") < events.indexOf("newContext"));
});
