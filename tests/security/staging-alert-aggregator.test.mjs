import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  aggregateStagingAlerts,
  DEDUP_WINDOW_MS,
  MAX_ALERT_BATCH,
  MAX_DEDUP_STATE_ENTRIES,
  MAX_SUMMARY_LENGTH,
  sanitizeAlertSummary,
} from "../../infra/observability/staging-alert-aggregator.mjs";

const base = 1_700_000_000_000;
const at = (offset = 0) => new Date(base + offset).toISOString();
const options = { now: at() };

test("accepts each operational source with one fixed dry-run schema", () => {
  const sources = ["health-check", "login-probe", "supabase-pool-monitor", "resource-alert", "meta-watchdog", "browser-smoke"];
  const result = aggregateStagingAlerts(
    sources.map((source, index) => ({ source, key: `signal-${index}`, summary: "status=degraded", occurredAt: at() })),
    {},
    options,
  );

  assert.equal(result.mode, "dry-run");
  assert.equal(result.emitted.length, sources.length);
  assert.deepEqual(Object.keys(result.emitted[0]), ["source", "key", "summary", "occurredAt"]);
  assert.deepEqual(Object.keys(result), ["mode", "emitted", "suppressed", "nextState"]);
});

test("deduplicates only the same source:key in the injected five-minute window", () => {
  const result = aggregateStagingAlerts([
    { source: "health-check", key: "service_down", summary: "status=500", occurredAt: at() },
    { source: "health-check", key: "service_down", summary: "status=500", occurredAt: at(DEDUP_WINDOW_MS - 1) },
    { source: "login-probe", key: "service_down", summary: "status=500", occurredAt: at(DEDUP_WINDOW_MS - 1) },
    { source: "health-check", key: "different_key", summary: "status=500", occurredAt: at(DEDUP_WINDOW_MS - 1) },
    { source: "health-check", key: "service_down", summary: "status=500", occurredAt: at(DEDUP_WINDOW_MS) },
  ], {}, { now: at(DEDUP_WINDOW_MS) });

  assert.deepEqual(result.emitted.map(({ source, key }) => [source, key]), [
    ["health-check", "service_down"],
    ["login-probe", "service_down"],
    ["health-check", "different_key"],
    ["health-check", "service_down"],
  ]);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, "deduplicated");
});

test("uses a bounded supplied state and fails closed for stale or oversized state", () => {
  const prior = { "health-check:service_down": base };
  const result = aggregateStagingAlerts([
    { source: "health-check", key: "service_down", summary: "status=500", occurredAt: at(1_000) },
  ], prior, { now: at(1_000) });
  assert.equal(result.emitted.length, 0);
  assert.equal(result.suppressed.length, 1);

  const oversized = Object.fromEntries(Array.from({ length: MAX_DEDUP_STATE_ENTRIES + 1 }, (_, index) => [
    `health-check:key-${index}`,
    base,
  ]));
  assert.throws(() => aggregateStagingAlerts([], oversized, options), /maximum entry count/);
  assert.throws(
    () => aggregateStagingAlerts([{ source: "sentry", key: "late", summary: "x", occurredAt: at(-DEDUP_WINDOW_MS - 1) }], {}, options),
    /outside the injected deduplication window/,
  );
});

test("recursively redacts hostile nested, cyclic, deep, PII, database, path, stack, newline, and unicode detail", () => {
  const cyclic = { headers: { authorization: "Bearer token-secret", cookie: "session=secret" } };
  cyclic.self = cyclic;
  let deep = cyclic;
  for (let index = 0; index < 12; index += 1) deep = { nested: deep };

  const result = aggregateStagingAlerts([{ source: "sentry", key: "unsafe", summary: deep, occurredAt: at() }], {}, options);
  assert.equal(result.emitted[0].summary, "[REDACTED_NESTED_DETAIL]");

  const summary = sanitizeAlertSummary("token=abc cookie=xyz email=person@example.com +971 50 123 4567 Key (email)=(person@example.com) /srv/app/private.ts\nstack\u202e");
  for (const forbidden of ["abc", "xyz", "person@example.com", "971", "/srv/app", "private.ts", "\n", "\u202e"]) {
    assert.equal(summary.includes(forbidden), false);
  }
  assert.ok(summary.length <= MAX_SUMMARY_LENGTH);
});

test("fails closed for send mode, malformed alerts, and oversized batches", () => {
  assert.throws(() => aggregateStagingAlerts([], {}, { mode: "send", now: at() }), /dry-run only/);
  assert.throws(() => aggregateStagingAlerts([{ source: "unknown", key: "x", summary: "x", occurredAt: at() }], {}, options), /unsupported alert source/);
  assert.throws(() => aggregateStagingAlerts([{ source: "sentry", key: "x", summary: "x", occurredAt: "not-a-date" }], {}, options), /valid occurredAt/);
  const batch = Array.from({ length: MAX_ALERT_BATCH + 1 }, (_, index) => ({ source: "sentry", key: `batch-${index}`, summary: "x", occurredAt: at() }));
  assert.throws(() => aggregateStagingAlerts(batch, {}, options), /maximum size/);
});

test("direct execution performs zero network or filesystem writes", () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = fs.writeFileSync;
  const originalAppend = fs.appendFileSync;
  const originalMkdir = fs.mkdirSync;
  let networkCalls = 0;
  let filesystemCalls = 0;
  globalThis.fetch = () => { networkCalls += 1; throw new Error("network must not be called"); };
  fs.writeFileSync = () => { filesystemCalls += 1; throw new Error("filesystem must not be called"); };
  fs.appendFileSync = () => { filesystemCalls += 1; throw new Error("filesystem must not be called"); };
  fs.mkdirSync = () => { filesystemCalls += 1; throw new Error("filesystem must not be called"); };
  try {
    const result = aggregateStagingAlerts([{ source: "browser-smoke", key: "ok", summary: "healthy", occurredAt: at() }], {}, options);
    assert.equal(result.emitted.length, 1);
    assert.equal(networkCalls, 0);
    assert.equal(filesystemCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.writeFileSync = originalWrite;
    fs.appendFileSync = originalAppend;
    fs.mkdirSync = originalMkdir;
  }
});
