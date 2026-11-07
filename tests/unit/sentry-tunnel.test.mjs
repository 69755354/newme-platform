// S7 review must-fix 1: the browser error forwarder must not relay cookies,
// must refuse other projects' DSNs, must refuse oversize bodies, POST only.
import assert from "node:assert/strict";
import test from "node:test";
import { handleTunnelRequest, resolveTunnelTarget, TUNNEL_MAX_BYTES } from "../../src/lib/sentry-tunnel.mjs";

const ENV = { SENTRY_DSN: "https://0123456789abcdef0123456789abcdef@o1234.ingest.sentry.io/4500" };

function envelope(dsn, extra = "") {
  return `${JSON.stringify({ event_id: "e1", dsn })}\n{"type":"event"}\n{"message":"x${extra}"}\n`;
}
function post(body, headers = {}) {
  return new Request("https://app.example.test/monitoring-tunnel", { method: "POST", body, headers });
}
function recorder(status = 200) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response("{}", { status }); } };
}

test("target comes from the server environment and must be a Sentry https DSN", () => {
  assert.deepEqual(resolveTunnelTarget(ENV), { host: "o1234.ingest.sentry.io", projectId: "4500", upstream: "https://o1234.ingest.sentry.io/api/4500/envelope/" });
  assert.equal(resolveTunnelTarget({}), null);
  assert.equal(resolveTunnelTarget({ SENTRY_DSN: "https://k@evil.example.com/1" }), null);
  assert.equal(resolveTunnelTarget({ SENTRY_DSN: "http://k@o1.ingest.sentry.io/1" }), null);
  // Legacy DSN with a secret half still resolves, and the secret is never part of the upstream URL.
  const legacy = resolveTunnelTarget({ SENTRY_DSN: "https://pub:sec@o1.ingest.sentry.io/9" });
  assert.equal(legacy.upstream, "https://o1.ingest.sentry.io/api/9/envelope/");
});

test("request carrying login cookies reaches upstream with NO cookie, authorization or forwarded-for", async () => {
  const { calls, fetchImpl } = recorder();
  const res = await handleTunnelRequest(post(envelope(ENV.SENTRY_DSN), {
    cookie: "sb-access-token=AAA; sb-refresh-token=BBB",
    authorization: "Bearer CCC",
    "x-forwarded-for": "203.0.113.9",
    "x-real-ip": "203.0.113.9",
    "content-type": "text/plain;charset=UTF-8",
    origin: "https://app.example.test",
  }), { env: ENV, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://o1234.ingest.sentry.io/api/4500/envelope/");
  assert.deepEqual(Object.keys(calls[0].init.headers), ["content-type"]);
  const all = JSON.stringify(calls[0].init.headers).toLowerCase();
  for (const bad of ["cookie", "sb-access", "bearer", "authorization", "203.0.113.9", "forwarded"]) assert.ok(!all.includes(bad), bad);
  assert.equal(calls[0].init.redirect, "error");
});

test("an envelope for another Sentry project or host is refused with 403 and never forwarded", async () => {
  const { calls, fetchImpl } = recorder();
  for (const dsn of [
    "https://0123456789abcdef0123456789abcdef@o1234.ingest.sentry.io/4501",
    "https://0123456789abcdef0123456789abcdef@o9999.ingest.sentry.io/4500",
    "https://0123456789abcdef0123456789abcdef@o1234.ingest.sentry.io.evil.test/4500",
    "http://0123456789abcdef0123456789abcdef@o1234.ingest.sentry.io/4500",
  ]) {
    const res = await handleTunnelRequest(post(envelope(dsn)), { env: ENV, fetchImpl });
    assert.equal(res.status, 403, dsn);
  }
  assert.equal(calls.length, 0);
});

test("missing or malformed envelope header is a 400", async () => {
  const { calls, fetchImpl } = recorder();
  assert.equal((await handleTunnelRequest(post("not json\n{}"), { env: ENV, fetchImpl })).status, 400);
  assert.equal((await handleTunnelRequest(post('{"event_id":"x"}\n{}'), { env: ENV, fetchImpl })).status, 400);
  assert.equal((await handleTunnelRequest(post(""), { env: ENV, fetchImpl })).status, 400);
  assert.equal(calls.length, 0);
});

test("oversize body is refused with 413 (declared and streamed)", async () => {
  const { calls, fetchImpl } = recorder();
  const big = envelope(ENV.SENTRY_DSN, "y".repeat(TUNNEL_MAX_BYTES));
  assert.equal((await handleTunnelRequest(post(big), { env: ENV, fetchImpl })).status, 413);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(envelope(ENV.SENTRY_DSN))); c.enqueue(new Uint8Array(TUNNEL_MAX_BYTES)); c.close(); } });
  const streamed = new Request("https://app.example.test/monitoring-tunnel", { method: "POST", body: stream, duplex: "half" });
  assert.equal((await handleTunnelRequest(streamed, { env: ENV, fetchImpl })).status, 413);
  assert.equal(calls.length, 0);
});

test("only POST is accepted; unconfigured DSN is 503; upstream failure is 502", async () => {
  const { calls, fetchImpl } = recorder();
  for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
    assert.equal((await handleTunnelRequest(new Request("https://app.example.test/monitoring-tunnel", { method }), { env: ENV, fetchImpl })).status, 405);
  }
  assert.equal((await handleTunnelRequest(post(envelope(ENV.SENTRY_DSN)), { env: {}, fetchImpl })).status, 503);
  const failing = async () => { throw new Error("boom"); };
  assert.equal((await handleTunnelRequest(post(envelope(ENV.SENTRY_DSN)), { env: ENV, fetchImpl: failing })).status, 502);
  const rejecting = recorder(500);
  assert.equal((await handleTunnelRequest(post(envelope(ENV.SENTRY_DSN)), { env: ENV, fetchImpl: rejecting.fetchImpl })).status, 502);
  assert.equal(calls.length, 0);
});
