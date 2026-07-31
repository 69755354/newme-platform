import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BoundedReplayStore,
  HermesTransportError,
  SAM52_MAX_ATTEMPTS,
  SAM52_MAX_BODY_BYTES,
  deliverSentryAlert,
  parseSentryAlertPayload,
  readBoundedRequestBody,
  sentrySignature,
} from "../../src/lib/sentry-webhook-bridge.mjs";

const secret = "sam52-test-service-hook-secret-000000000000000000";
const validBody = JSON.stringify({
  action: "triggered",
  actor: { type: "application", name: "sentry" },
  data: {
    event: {
      event_id: "0123456789abcdef0123456789abcdef",
      environment: "staging",
      level: "error",
      project: { slug: "javascript-nextjs" },
      title: "customer synthetic@invalid.test failed",
      user: { email: "synthetic@invalid.test" },
    },
    triggered_rule: "SAM52 >= 6 errors",
  },
  installation: { uuid: "11111111-2222-4333-8444-555555555555" },
});

function request(overrides = {}) {
  return {
    rawBody: validBody,
    signature: sentrySignature(secret, validBody),
    resource: "event.alert",
    deliveryId: "sam52-test-delivery-00000001",
    secret,
    replayStore: new BoundedReplayStore(),
    transport: { send: async () => {} },
    sleep: async () => {},
    ...overrides,
  };
}

test("valid signed delivery is normalized, retried within a bound, and deduplicated", async () => {
  const audit = [];
  let sends = 0;
  const replayStore = new BoundedReplayStore();
  const transport = {
    async send(envelope) {
      sends += 1;
      assert.deepEqual(Object.keys(envelope).sort(), [
        "deliveryId",
        "environment",
        "eventId",
        "kind",
        "level",
        "project",
        "rule",
        "schemaVersion",
      ]);
      if (sends < 3) throw new HermesTransportError("retry", true);
    },
  };
  const first = await deliverSentryAlert(request({
    replayStore,
    transport,
    audit: (entry) => audit.push(entry),
  }));
  const duplicate = await deliverSentryAlert(request({
    replayStore,
    transport,
    audit: (entry) => audit.push(entry),
  }));

  assert.equal(first.duplicate, false);
  assert.equal(first.attempts, SAM52_MAX_ATTEMPTS);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.attempts, 0);
  assert.equal(sends, SAM52_MAX_ATTEMPTS);
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /synthetic@invalid\.test/);
  assert.doesNotMatch(serialized, /customer synthetic/);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /sam52-test-delivery-00000001/);
});

test("failed delivery releases the replay claim for a later Sentry retry", async () => {
  const replayStore = new BoundedReplayStore();
  await assert.rejects(
    deliverSentryAlert(request({
      replayStore,
      transport: {
        send: async () => {
          throw new HermesTransportError("temporary", true);
        },
      },
    })),
    (error) => error.code === "delivery_failed" && error.status === 503,
  );
  const recovered = await deliverSentryAlert(request({
    replayStore,
    transport: { send: async () => {} },
  }));
  assert.equal(recovered.duplicate, false);
  assert.equal(recovered.attempts, 1);
});

test("signature, resource, request id, body size, and strict schema fail closed", async () => {
  await assert.rejects(
    deliverSentryAlert(request({ signature: "0".repeat(64) })),
    (error) => error.code === "signature_invalid" && error.status === 401,
  );
  await assert.rejects(
    deliverSentryAlert(request({ resource: "issue" })),
    (error) => error.code === "hook_resource_invalid",
  );
  await assert.rejects(
    deliverSentryAlert(request({ deliveryId: "short" })),
    (error) => error.code === "hook_request_id_invalid",
  );
  assert.throws(
    () => parseSentryAlertPayload("x".repeat(64 * 1024 + 1)),
    (error) => error.code === "payload_too_large" && error.status === 413,
  );
  const unknownRoot = JSON.stringify({
    ...JSON.parse(validBody),
    unexpected: true,
  });
  assert.throws(
    () => parseSentryAlertPayload(unknownRoot),
    (error) => error.code === "payload_root_key_unknown",
  );
  const invalidEvent = JSON.stringify({
    action: "triggered",
    data: {
      event: {
        event_id: "not-an-event-id",
        level: "info",
        project: "../escape",
      },
      triggered_rule: "",
    },
  });
  assert.throws(
    () => parseSentryAlertPayload(invalidEvent),
    (error) => error.code === "payload_event_id_invalid",
  );
});

test("raw byte signatures work and request bodies are bounded while streaming", async () => {
  const bodyBytes = Buffer.from(validBody, "utf8");
  const delivered = await deliverSentryAlert(request({
    rawBody: bodyBytes,
    signature: sentrySignature(secret, bodyBytes),
  }));
  assert.equal(delivered.duplicate, false);
  assert.equal(delivered.attempts, 1);

  let pulls = 0;
  const oversizedStream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(32 * 1024));
      if (pulls === 3) controller.close();
    },
  });
  await assert.rejects(
    readBoundedRequestBody({
      headers: new Headers(),
      body: oversizedStream,
    }),
    (error) => error.code === "payload_too_large" && error.status === 413,
  );
  assert.equal(pulls, 3);

  let bodyWasRead = false;
  await assert.rejects(
    readBoundedRequestBody({
      headers: new Headers({
        "content-length": String(SAM52_MAX_BODY_BYTES + 1),
      }),
      get body() {
        bodyWasRead = true;
        return null;
      },
    }),
    (error) => error.code === "payload_too_large" && error.status === 413,
  );
  assert.equal(bodyWasRead, false);
});

test("route uses raw body HMAC, fixed headers, no-store, and configured Hermes abstraction", async () => {
  const route = await readFile(
    new URL("../../src/app/api/sentry-webhook/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /await readBoundedRequestBody\(request\)/);
  assert.doesNotMatch(route, /request\.text\(\)/);
  assert.doesNotMatch(route, /request\.json\(\)/);
  assert.match(route, /sentry-hook-signature/);
  assert.match(route, /sentry-hook-resource/);
  assert.match(route, /sentry-hook-request-id/);
  assert.match(route, /SENTRY_SERVICE_HOOK_SECRET/);
  assert.match(route, /HERMES_SENTRY_BRIDGE_URL/);
  assert.match(route, /HERMES_SENTRY_BRIDGE_TOKEN/);
  assert.match(route, /no-store, max-age=0/);
  assert.doesNotMatch(route, /console\.(?:log|error|warn)/);
});
