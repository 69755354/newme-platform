#!/usr/bin/env node
// STAGING ONLY. Entry point that runs INSIDE the production acceptance Playwright
// image for the staging rehearsal (see scripts/rehearse-postdeploy-browser-uat.mjs).
//
// It runs the production browser route -- scripts/run-postdeploy-browser-uat.mjs,
// byte for byte, canonical origin https://app.newme.ae and all -- and changes only
// where the browser looks that name up: a Chromium host-resolver rule sends
// app.newme.ae to the rehearsal TLS forwarder on this machine, which relays to the
// staging app. The runner is never edited, never forked, and keeps its own
// pass/fail rules; this file only adds read-only listeners that print WHY a
// session failed (the runner itself reports counts only).
//
// stdin: the runner's own input document. argv[2]: rehearsal forwarder port.
import dns from "node:dns";
import tls from "node:tls";

import { chromium } from "playwright";

import { REQUIRED_LOCALES, REQUIRED_ROLES, buildSafeFailureOutput, runBrowserUat } from "./run-postdeploy-browser-uat.mjs";

const CANONICAL_HOST = "app.newme.ae";
/**
 * The staging app's browser bundle talks to the STAGING Supabase project, whose origin
 * the production runner (rightly) does not allow: it only knows the production data
 * origin. Without this, every lead-detail read is aborted by the runner's own network
 * guard and the rehearsal would fail for a reason production never sees. These two
 * routes are registered after the runner's, so they take precedence for this one
 * origin only, and relay the request to the staging project unchanged. Nothing is ever
 * sent to the production data origin.
 */
export const STAGING_DATA_ORIGIN = "https://bfsiibofuzoglziltgyd.supabase.co";

export function rehearsalLaunchArgs(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid rehearsal port");
  return [`--host-resolver-rules=MAP ${CANONICAL_HOST} 127.0.0.1:${port}`, "--ignore-certificate-errors"];
}

/**
 * The runner also calls `context.request.get(...)` (identity read, post-logout check).
 * That client is Node's, not Chromium's, so the Chromium host rule does not reach it.
 * Point the same name at the same forwarder for Node's resolver and TLS connect, for
 * this one host only; every other name resolves and connects as usual.
 */
export function installNodeResolution(port, { dnsModule = dns, tlsModule = tls } = {}) {
  const realLookup = dnsModule.promises.lookup.bind(dnsModule.promises);
  dnsModule.promises.lookup = async (host, options) => {
    if (host !== CANONICAL_HOST) return realLookup(host, options);
    const addresses = options?.family === 6 ? [] : [{ address: "127.0.0.1", family: 4 }];
    return options?.all ? addresses : addresses[0];
  };
  const realConnect = tlsModule.connect.bind(tlsModule);
  tlsModule.connect = (options, ...rest) => {
    if (options && typeof options === "object" && options.servername === CANONICAL_HOST && Number(options.port) === 443) {
      return realConnect({ ...options, host: "127.0.0.1", port }, ...rest);
    }
    return realConnect(options, ...rest);
  };
}

export function diagnosticLine(label, kind, detail) {
  const text = String(detail).replace(/\s+/g, " ").slice(0, 300);
  return `REHEARSAL-DIAG ${label} ${kind} ${text}\n`;
}

async function relayStagingData(context) {
  await context.route(`${STAGING_DATA_ORIGIN}/**`, async (route) => {
    try {
      await route.fulfill({ response: await route.fetch() });
    } catch {
      await route.abort("failed").catch(() => {});
    }
  });
  await context.routeWebSocket(/^wss:\/\/bfsiibofuzoglziltgyd\.supabase\.co\//, (webSocketRoute) => {
    webSocketRoute.connectToServer();
  });
}

function attachDiagnostics(page, label, write) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const where = message.location()?.url ? ` @${new URL(message.location().url, "https://x").pathname}` : "";
    write(diagnosticLine(label, "console.error", `${message.text()}${where}`));
  });
  page.on("pageerror", (error) => write(diagnosticLine(label, "pageerror", error?.message ?? error)));
  page.on("requestfailed", (request) => {
    write(diagnosticLine(label, "requestfailed", `${request.resourceType()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ""}`));
  });
  page.on("response", (response) => {
    if (response.status() >= 400) write(diagnosticLine(label, "http", `${response.status()} ${new URL(response.url()).pathname}`));
  });
}

export function rehearsalBrowserType(port, write = (line) => process.stderr.write(line)) {
  return {
    async launch(options) {
      const browser = await chromium.launch({ ...options, args: [...(options?.args ?? []), ...rehearsalLaunchArgs(port)] });
      // The runner opens one context per (role, locale) in this order.
      const order = REQUIRED_ROLES.flatMap((role) => REQUIRED_LOCALES.map((locale) => `${role}/${locale}`));
      let sessions = 0;
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (contextOptions) => {
        const label = order[sessions++] ?? `session${sessions}`;
        const context = await newContext(contextOptions);
        const apiGet = context.request.get.bind(context.request);
        context.request.get = async (...args) => {
          try { return await apiGet(...args); } catch (error) { write(diagnosticLine(label, "api-request-error", error?.message ?? error)); throw error; }
        };
        const newPage = context.newPage.bind(context);
        let relayed = false;
        context.newPage = async () => {
          if (!relayed) {
            relayed = true;
            await relayStagingData(context);
          }
          const page = await newPage();
          attachDiagnostics(page, label, write);
          return page;
        };
        return context;
      };
      return browser;
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  try {
    const port = Number(argv[0]);
    rehearsalLaunchArgs(port);
    installNodeResolution(port);
    const input = JSON.parse(await readStdin());
    const output = await runBrowserUat(input, { browserType: rehearsalBrowserType(port) });
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(buildSafeFailureOutput(error?.code))}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
