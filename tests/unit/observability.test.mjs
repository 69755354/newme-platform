import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { readFile } from "node:fs/promises";
import {
  createPinoHooks,
  sanitizeSentryEvent,
  sanitizeValue,
  serializeErr,
} from "../../src/lib/observability.mjs";

test("real pino output recursively redacts nested context and preserves safe fields", () => {
  let output = "";
  const stream = { write: (chunk) => { output += chunk; } };
  const logger = pino({ base: null, hooks: createPinoHooks() }, stream);
  logger.info({
    code: "PGRST116",
    request_id: "req-1",
    headers: { authorization: "Bearer secret-token", cookie: "session=secret-cookie" },
    values: [{ email: "person@example.com", phone: "+971 50 123 4567", token: "nested-token" }],
  }, "tracked");
  const parsed = JSON.parse(output);
  assert.equal(parsed.code, "PGRST116");
  assert.equal(parsed.request_id, "req-1");
  assert.equal(parsed.headers.authorization, "[REDACTED]");
  assert.equal(parsed.headers.cookie, "[REDACTED]");
  assert.equal(parsed.values[0].email, "[REDACTED]");
  assert.equal(parsed.values[0].phone, "[REDACTED]");
  assert.equal(parsed.values[0].token, "[REDACTED]");
});

test("serializes database Error causes without leaking sensitive text", () => {
  const cause = new Error("query failed for person@example.com");
  cause.code = "PGRST116";
  cause.details = "Key (email)=(person@example.com) violates policy";
  cause.hint = "token=secret-token";
  const error = new Error("database password=secret-password phone=+971501234567", { cause });
  error.code = "23505";
  const output = serializeErr(error);
  const json = JSON.stringify(output);
  assert.equal(output.code, "23505");
  assert.equal(output.cause.code, "PGRST116");
  assert.match(json, /database/);
  assert.match(json, /PGRST116/);
  assert.doesNotMatch(json, /person@example\.com|secret-password|secret-token|971501234567/);
});

test("bounds Error cause cycles and depth", () => {
  const self = new Error("self");
  self.cause = self;
  assert.equal(serializeErr(self).cause, "[Circular]");

  let current = new Error("root");
  const root = current;
  for (let index = 0; index < 12; index += 1) {
    current.cause = new Error(`cause-${index}`);
    current = current.cause;
  }
  const serialized = JSON.stringify(serializeErr(root));
  assert.match(serialized, /\[Truncated\]/);
});

test("handles arrays, circular references and bounded values", () => {
  const circular = { safe: "keep", list: ["Bearer array-token", { email: "a@example.com" }] };
  circular.self = circular;
  let nested = { value: "keep" };
  for (let i = 0; i < 8; i += 1) nested = { nested };
  const output = sanitizeValue({ circular, nested });
  assert.equal(output.circular.self, "[Circular]");
  assert.equal(output.circular.list[0], "Bearer [REDACTED]");
  assert.equal(output.circular.list[1].email, "[REDACTED]");
  assert.equal(output.nested.nested.nested.nested.nested.nested, "[Truncated]");
});

test("preserves safe tracking fields and filters health/readiness noise", () => {
  const event = {
    transaction: "/api/leads/123",
    request: { headers: { authorization: "Bearer token" } },
    tags: { request_id: "req-1", release: "rel-1", build: "build-1", code: "PGRST116" },
  };
  const output = sanitizeSentryEvent(event);
  assert.equal(output.tags.request_id, "req-1");
  assert.equal(output.tags.release, "rel-1");
  assert.equal(output.tags.build, "build-1");
  assert.equal(output.tags.code, "PGRST116");
  assert.equal(output.request.headers.authorization, "[REDACTED]");
  assert.equal(sanitizeSentryEvent({ transaction: "/api/ready" }), null);
});

test("Sentry configs declare release, environment, build tag and PII policy", async () => {
  const [client, server, edge] = await Promise.all([
    readFile(new URL("../../sentry.client.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../../sentry.server.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../../sentry.edge.config.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [client, server, edge]) {
    assert.match(source, /sendDefaultPii: false/);
    assert.match(source, /environment:/);
    assert.match(source, /initialScope:/);
    assert.match(source, /build:/);
    assert.match(source, /beforeSend:/);
    assert.match(source, /beforeSendTransaction:/);
  }
  assert.match(client, /NEXT_PUBLIC_APP_VERSION/);
  assert.match(server, /SENTRY_RELEASE/);
});


test("Sentry preserves bounded stack frames while redacting exception messages", () => {
  const event = {
    exception: {
      values: [{
        value: "password=secret-password email=person@example.com",
        stacktrace: {
          frames: Array.from({ length: 10 }, (_, index) => ({
            filename: `/app/src/file-${index}.mjs`,
            function: `handler${index}`,
            lineno: index + 1,
          })),
        },
      }],
    },
  };
  const output = sanitizeSentryEvent(event);
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /secret-password|person@example\\.com/);
  assert.equal(output.exception.values[0].stacktrace.frames.length, 10);
  assert.equal(output.exception.values[0].stacktrace.frames[9].function, "handler9");
  assert.equal(output.exception.values[0].stacktrace.frames[9].filename, "/app/src/file-9.mjs");
});
