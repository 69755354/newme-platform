import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BoundedReplayStore,
  HermesTransportError,
  deliverSentryAlert,
  sentrySignature,
} from "../src/lib/sentry-webhook-bridge.mjs";

const expectedSha = process.env.SAM52_EXPECTED_RELEASE_SHA;
if (!/^[0-9a-f]{40}$/.test(expectedSha ?? "")) {
  throw new Error("SAM52 expected release SHA is required");
}

const manifest = JSON.parse(
  await readFile("/opt/newme-staging/current/manifest.json", "utf8"),
);
if (manifest.git_sha !== expectedSha) {
  throw new Error("SAM52 current release manifest mismatch");
}

const secret = "sam52-synthetic-service-hook-secret-0000000000000000";
const payload = JSON.stringify({
  action: "triggered",
  data: {
    event: {
      event_id: "9f2d4e6a8b0c1d3e5f709182a4b6c8d0",
      environment: "staging",
      level: "error",
      project: { slug: "javascript-nextjs" },
      title: "synthetic title must never enter audit",
      user: { email: "synthetic@invalid.test" },
    },
    triggered_rule: "SAM52 synthetic threshold",
  },
});
const signature = sentrySignature(secret, payload);
const request = {
  rawBody: payload,
  signature,
  resource: "event.alert",
  deliveryId: "sam52-synthetic-delivery-0001",
  secret,
};
const auditEntries = [];
let transportCalls = 0;
const retryingTransport = {
  async send() {
    transportCalls += 1;
    if (transportCalls < 3) {
      throw new HermesTransportError("synthetic_retry", true);
    }
  },
};
const replayStore = new BoundedReplayStore();
const first = await deliverSentryAlert({
  ...request,
  replayStore,
  transport: retryingTransport,
  audit: (entry) => auditEntries.push(entry),
  sleep: async () => {},
});
const duplicate = await deliverSentryAlert({
  ...request,
  replayStore,
  transport: retryingTransport,
  audit: (entry) => auditEntries.push(entry),
  sleep: async () => {},
});

let invalidSignatureRejected = false;
try {
  await deliverSentryAlert({
    ...request,
    deliveryId: "sam52-synthetic-delivery-0002",
    signature: "0".repeat(64),
    replayStore: new BoundedReplayStore(),
    transport: retryingTransport,
  });
} catch (error) {
  invalidSignatureRejected = error?.code === "signature_invalid";
}

let invalidSchemaRejected = false;
const invalidPayload =
  '{"action":"triggered","data":{"event":{"event_id":'
  + '"9f2d4e6a8b0c1d3e5f709182a4b6c8d0","level":"error",'
  + '"project":"javascript-nextjs","__proto__":"rejected"},'
  + '"triggered_rule":"SAM52 synthetic threshold"}}';
try {
  await deliverSentryAlert({
    ...request,
    rawBody: invalidPayload,
    signature: sentrySignature(secret, invalidPayload),
    deliveryId: "sam52-synthetic-delivery-0003",
    replayStore: new BoundedReplayStore(),
    transport: retryingTransport,
  });
} catch (error) {
  invalidSchemaRejected =
    error?.code === "payload_prototype_key_rejected" ||
    error?.code === "payload_event_invalid";
}

const serializedAudit = JSON.stringify(auditEntries);
const auditRedacted =
  !serializedAudit.includes("synthetic title") &&
  !serializedAudit.includes("synthetic@invalid.test") &&
  !serializedAudit.includes(secret) &&
  !serializedAudit.includes(request.deliveryId);

const ok =
  first.duplicate === false &&
  first.attempts === 3 &&
  duplicate.duplicate === true &&
  duplicate.attempts === 0 &&
  transportCalls === 3 &&
  invalidSignatureRejected &&
  invalidSchemaRejected &&
  auditRedacted;
if (!ok) throw new Error("SAM52 synthetic bridge contract failed");

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  linearId: "SAM-52",
  releaseSha: expectedSha,
  target: "staging-local-synthetic",
  bridge: {
    status: "passed",
    signature: "verified",
    schema: "strict",
    replay: "deduplicated",
    retryAttempts: first.attempts,
    audit: "redacted",
    evidenceDigest: createHash("sha256")
      .update(serializedAudit)
      .digest("hex"),
  },
  external: {
    status: "blocked",
    reason: "third_party_configuration_not_authorized",
    required: [
      "sentry_alert_rule_owner",
      "sentry_service_hook_secret",
      "hermes_destination_owner",
      "wecom_or_telegram_credentials",
    ],
  },
  cleanup: {
    status: "not_applicable",
    reason: "synthetic_in_memory_transport_and_replay_store",
    fixtureIds: [],
  },
}));
