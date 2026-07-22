import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("SAM-27 registers Sentry for both server runtimes", async () => {
  const instrumentation = await read("instrumentation.ts");

  assert.match(
    instrumentation,
    /NEXT_RUNTIME === "nodejs"[\s\S]*await import\("\.\/sentry\.server\.config"\)/,
  );
  assert.match(
    instrumentation,
    /NEXT_RUNTIME === "edge"[\s\S]*await import\("\.\/sentry\.edge\.config"\)/,
  );
});

test("SAM-27 forwards Next.js request errors to Sentry", async () => {
  const instrumentation = await read("instrumentation.ts");

  assert.match(
    instrumentation,
    /export const onRequestError = Sentry\.captureRequestError;/,
  );
});

test("SAM-27 keeps health-check errors and transactions out of Sentry", async () => {
  const serverConfig = await read("sentry.server.config.ts");

  assert.match(
    serverConfig,
    /beforeSend\(event\)[\s\S]*event\.request\?\.url[\s\S]*\/api\/health[\s\S]*return null;/,
  );
  assert.match(
    serverConfig,
    /beforeSendTransaction\(event\)[\s\S]*event\.transaction\?\.includes\("\/api\/health"\)[\s\S]*return null;/,
  );
});
