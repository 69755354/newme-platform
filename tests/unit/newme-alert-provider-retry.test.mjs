import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isConnectPhaseError,
  providerRequest,
} from "../../infra/observability/newme-alert-provider-v1.mjs";

const CONFIG = { bot_token: "123:fixture", chat_id: "-1", bot_user_id: "123" };
const connectError = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
const okResponse = (result) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

function harness(steps) {
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    options: {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const step = steps[calls.length - 1];
        if (step === undefined) throw new Error("unexpected extra fetch");
        if (step instanceof Error) throw step;
        return step();
      },
      sleep: async (ms) => { sleeps.push(ms); },
    },
  };
}

test("module import disables Happy Eyeballs so IPv4 is never abandoned for an unroutable IPv6", () => {
  assert.equal(net.getDefaultAutoSelectFamily(), false);
  const source = readFileSync(new URL("../../infra/observability/newme-alert-provider-v1.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf("net.setDefaultAutoSelectFamily(false)") < source.indexOf("fetchImpl("));
});

test("connection-phase errors are retried with a 1 s delay and then succeed", async () => {
  for (const code of ["ETIMEDOUT", "ENETUNREACH", "ECONNRESET", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]) {
    const h = harness([connectError(code), connectError(code), () => okResponse({ id: 123, is_bot: true })]);
    const result = await providerRequest(CONFIG, "getMe", undefined, h.options);
    assert.deepEqual(result, { id: 123, is_bot: true });
    assert.equal(h.calls.length, 3, code);
    assert.deepEqual(h.sleeps, [1000, 1000]);
  }
});

test("POST bodies are resent unchanged on a connection retry", async () => {
  const h = harness([connectError("ENETUNREACH"), () => okResponse({ message_id: 7 })]);
  await providerRequest(CONFIG, "sendMessage", { chat_id: "-1", text: "x" }, h.options);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].init.body, h.calls[1].init.body);
  assert.equal(h.calls[0].init.signal, h.calls[1].init.signal, "one deadline covers every attempt");
});

test("gives up after two retries", async () => {
  const h = harness([connectError("ENETUNREACH"), connectError("ENETUNREACH"), connectError("ENETUNREACH")]);
  await assert.rejects(providerRequest(CONFIG, "getMe", undefined, h.options), /provider_request_failed/);
  assert.equal(h.calls.length, 3);
});

test("non-connection fetch failures are not retried", async () => {
  for (const error of [new TypeError("fetch failed"), connectError("UND_ERR_SOCKET"), Object.assign(new Error("t"), { name: "TimeoutError" })]) {
    const h = harness([error, () => okResponse({})]);
    await assert.rejects(providerRequest(CONFIG, "sendMessage", { text: "x" }, h.options), /provider_request_failed/);
    assert.equal(h.calls.length, 1);
  }
});

test("HTTP 4xx/5xx responses are never retried", async () => {
  for (const status of [400, 401, 429, 500, 502]) {
    const h = harness([
      () => new Response(JSON.stringify({ ok: false, description: "x" }), { status }),
      () => okResponse({ message_id: 1 }),
    ]);
    await assert.rejects(providerRequest(CONFIG, "sendMessage", { text: "x" }, h.options), /provider_response_refused/);
    assert.equal(h.calls.length, 1, String(status));
    assert.deepEqual(h.sleeps, []);
  }
  const invalid = harness([() => new Response("<html>", { status: 502 }), () => okResponse({})]);
  await assert.rejects(providerRequest(CONFIG, "getMe", undefined, invalid.options), /provider_response_invalid/);
  assert.equal(invalid.calls.length, 1);
});

test("isConnectPhaseError accepts aggregate connect failures only when every inner error is connection-phase", () => {
  const aggregate = (codes) => new TypeError("fetch failed", {
    cause: new AggregateError(codes.map((code) => Object.assign(new Error(code), { code }))),
  });
  assert.equal(isConnectPhaseError(aggregate(["ETIMEDOUT", "ENETUNREACH"])), true);
  assert.equal(isConnectPhaseError(aggregate(["ETIMEDOUT", "EPROTO"])), false);
  assert.equal(isConnectPhaseError(aggregate([])), false);
  assert.equal(isConnectPhaseError(new Error("no cause")), false);
});
