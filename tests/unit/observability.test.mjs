import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeSentryEvent,
  sanitizeValue,
  serializeErr,
} from "../../src/lib/observability.mjs";

test("recursively redacts nested headers, cookies, tokens and PII", () => {
  const input = {
    request: {
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=secret-cookie",
        nested: [{ email: "person@example.com", phone: "+971 50 123 4567" }],
      },
    },
    details: {
      access_token: "access-token",
      profile: { phone: "+1 555 123 4567" },
    },
  };

  const output = sanitizeValue(input);
  assert.equal(output.request.headers.authorization, "[REDACTED]");
  assert.equal(output.request.headers.cookie, "[REDACTED]");
  assert.equal(output.request.headers.nested[0].email, "[REDACTED]");
  assert.equal(output.request.headers.nested[0].phone, "[REDACTED]");
  assert.equal(output.details.access_token, "[REDACTED]");
  assert.equal(output.details.profile.phone, "[REDACTED]");
});

test("serializes Error causes and database fields without leaking sensitive text", () => {
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

test("handles arrays, circular references and bounded depth", () => {
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

test("preserves safe tracking fields and drops health/readiness noise", () => {
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
