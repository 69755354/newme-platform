// S7 (5-logging-monitoring.md "Sentry 上报内容的脱敏 · 缺口"): the scrubber only
// recognised e-mail/phone *formats*. Customer names, notes, chat bodies, request
// bodies, query strings and the user object reached Sentry unchanged. These tests
// pin the minimised event shape: no customer PII may survive either hook.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
  sanitizeValue,
} from "../../src/lib/observability.mjs";

const CUSTOMER = "Fatima Al Mansouri";
const NOTE = "prefers villa in Arabian Ranches, budget tight";
const SEARCH = "Fatima";

function eventWithCustomerData() {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    sdk: { name: "sentry.javascript.nextjs", version: "10.75.2" },
    contexts: { browser: { name: "Chrome" }, os: { name: "Linux" } },
    transaction: "/leads/[id]",
    message: "save failed",
    user: { id: "7c4f1a2e-1111-4111-8111-111111111111", email: "rep@example.com", username: "Omar Rep", ip_address: "203.0.113.9" },
    request: {
      url: `https://app.newme.ae/leads?search=${SEARCH}&phone=0501234567`,
      query_string: `search=${SEARCH}`,
      method: "POST",
      data: { customer_name: CUSTOMER, notes: NOTE },
      cookies: { "sb-access-token": "x" },
      headers: { "User-Agent": "Mozilla/5.0", Referer: `https://app.newme.ae/leads?search=${SEARCH}`, Cookie: "a=b" },
    },
    breadcrumbs: [
      { category: "ui.click", message: `div.lead-card[title="${CUSTOMER}"]`, timestamp: 1 },
      { category: "console", level: "log", message: `loaded lead ${CUSTOMER}`, data: { arguments: [CUSTOMER] }, timestamp: 2 },
      { category: "fetch", type: "http", data: { method: "GET", url: `/api/leads/list?q=${SEARCH}`, status_code: 500 }, timestamp: 3 },
      { category: "navigation", data: { from: `/leads?search=${SEARCH}`, to: "/leads/123" }, timestamp: 4 },
    ],
    extra: {
      log: {
        lead: { id: "lead-1", customer_name: CUSTOMER, name: CUSTOMER, remark: NOTE, decision_maker: CUSTOMER },
        whatsapp: { body: NOTE, wa_id: "971501234567" },
        route: "/api/leads/123",
      },
    },
    tags: { route: "/api/leads/123", request_id: "req-1" },
  };
}

test("browser/server events drop customer names, notes, bodies and query strings", () => {
  const output = sanitizeSentryEvent(eventWithCustomerData());
  const serialized = JSON.stringify(output);
  for (const leaked of [CUSTOMER, "Fatima", NOTE, "Arabian Ranches", "0501234567", "971501234567", "rep@example.com", "Omar Rep", "203.0.113.9", "sb-access-token"]) {
    assert.ok(!serialized.includes(leaked), `leaked ${leaked}`);
  }
  // Request body, cookies and query string are removed, not merely masked.
  assert.equal(output.request.data, undefined);
  assert.equal(output.request.cookies, undefined);
  assert.equal(output.request.query_string, undefined);
  assert.equal(output.request.url, "https://app.newme.ae/leads");
  // Only the actor id survives on the user object.
  assert.deepEqual(output.user, { id: "7c4f1a2e-1111-4111-8111-111111111111" });
});

test("debugging value is preserved: route, ids, status codes, sdk metadata", () => {
  const output = sanitizeSentryEvent(eventWithCustomerData());
  assert.equal(output.transaction, "/leads/[id]");
  assert.equal(output.tags.request_id, "req-1");
  assert.equal(output.extra.log.lead.id, "lead-1");
  assert.equal(output.extra.log.route, "/api/leads/123");
  assert.equal(output.sdk.name, "sentry.javascript.nextjs");
  assert.equal(output.contexts.browser.name, "Chrome");
  const fetchCrumb = output.breadcrumbs.find((crumb) => crumb.category === "fetch");
  assert.equal(fetchCrumb.data.status_code, 500);
  assert.equal(fetchCrumb.data.url, "/api/leads/list");
  const nav = output.breadcrumbs.find((crumb) => crumb.category === "navigation");
  assert.equal(nav.data.from, "/leads");
  assert.equal(nav.data.to, "/leads/123");
});

test("breadcrumbs in the {values} envelope shape are minimised too", () => {
  const event = eventWithCustomerData();
  event.breadcrumbs = { values: event.breadcrumbs };
  const serialized = JSON.stringify(sanitizeSentryEvent(event));
  assert.ok(!serialized.includes(CUSTOMER));
  assert.ok(!serialized.includes(SEARCH));
});

test("transaction spans lose query strings", () => {
  const output = sanitizeSentryTransaction({
    transaction: "/leads",
    request: { url: `https://app.newme.ae/leads?search=${SEARCH}` },
    spans: [{ op: "http.client", description: `GET /api/leads/list?q=${SEARCH}`, data: { url: `/api/leads/list?q=${SEARCH}`, "http.query": `q=${SEARCH}` } }],
  });
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes(SEARCH), serialized);
  assert.equal(output.spans[0].description, "GET /api/leads/list");
});

test("structured log context redacts person-name and free-text fields", () => {
  const output = sanitizeValue({ lead_id: "l1", customer_name: CUSTOMER, contact_name: CUSTOMER, notes: NOTE, operation: "x" });
  assert.equal(output.lead_id, "l1");
  assert.equal(output.operation, "x");
  assert.equal(output.customer_name, "[REDACTED]");
  assert.equal(output.contact_name, "[REDACTED]");
  assert.equal(output.notes, "[REDACTED]");
});

test("browser SDK is initialised from instrumentation-client with errors only and the PII hooks", async () => {
  const source = await readFile(new URL("../../instrumentation-client.ts", import.meta.url), "utf8");
  assert.match(source, /Sentry\.init\(/);
  assert.match(source, /NEXT_PUBLIC_SENTRY_DSN/);
  assert.match(source, /sendDefaultPii: false/);
  assert.match(source, /beforeSend: sanitizeSentryEvent/);
  assert.match(source, /beforeSendTransaction: sanitizeSentryTransaction/);
  assert.match(source, /tracesSampleRate: 0\b/);
  assert.doesNotMatch(source, /replaysSessionSampleRate|replayIntegration|browserProfilingIntegration/);
});

test("browser events travel through a same-origin tunnel (CSP and release browser gate)", async () => {
  const config = await readFile(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /tunnelRoute: "\/monitoring-tunnel"/);
});
