import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { REVIEW_SANDBOX, REVIEW_TEMPLATE_BODY, reviewToolsConfig, performReviewAction, runReviewAttempt, ReviewToolsError } from "../../src/lib/whatsapp-review-tools.mjs";

const now = Date.parse("2026-10-22T12:00:00Z");
const environment = () => ({ WHATSAPP_REVIEW_TOOLS_ENABLED: "true", WHATSAPP_REVIEW_ACCESS_TOKEN: "synthetic-review-credential",
  WHATSAPP_APP_SECRET: "synthetic-app-proof", WHATSAPP_REVIEW_TOOLS_FROM: "2026-10-22T11:00:00Z", WHATSAPP_REVIEW_TOOLS_UNTIL: "2026-10-22T13:00:00Z" });
const phones = () => ({ data: [{ id: REVIEW_SANDBOX.phoneId, display_phone_number: "+1 555 664 0296" }] });
const json = (body, status = 200) => Response.json(body, { status });
const failure = (code) => (error) => error instanceof ReviewToolsError && error.code === code;

test("test access is off by default and requires a bounded explicit UTC window and both credentials", () => {
  assert.equal(reviewToolsConfig({}, now).enabled, false);
  const env = environment();
  assert.equal(reviewToolsConfig(env, now).enabled, true);
  for (const key of Object.keys(env)) {
    assert.equal(reviewToolsConfig({ ...env, [key]: undefined }, now).enabled, false, key);
  }
  for (const [from, until] of [["invalid", env.WHATSAPP_REVIEW_TOOLS_UNTIL], [env.WHATSAPP_REVIEW_TOOLS_FROM, "2099-10-22T13:00:00Z"],
    ["2026-10-22T13:00:00Z", "2026-10-22T14:00:00Z"], ["2026-10-22T10:00:00Z", "2026-10-22T11:00:00Z"]]) {
    assert.equal(reviewToolsConfig({ ...env, WHATSAPP_REVIEW_TOOLS_FROM: from, WHATSAPP_REVIEW_TOOLS_UNTIL: until }, now).enabled, false);
  }
  assert.equal(JSON.stringify(reviewToolsConfig(env, now)).includes(env.WHATSAPP_REVIEW_ACCESS_TOKEN), false);
});

test("disabled or malformed actions make no network calls", async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error("must not run"); };
  await assert.rejects(performReviewAction("send_hello_world", randomUUID(), { env: {}, clock: () => now, fetchImpl }), failure("review_tools_disabled"));
  await assert.rejects(performReviewAction("send_arbitrary_message", randomUUID(), { env: environment(), clock: () => now, fetchImpl }), failure("invalid_action"));
  await assert.rejects(performReviewAction("send_hello_world", "../../anything", { env: environment(), clock: () => now, fetchImpl }), failure("invalid_action"));
  assert.equal(calls, 0);
});

test("a mismatch in either test phone ID or visible test sender prevents every mutation", async () => {
  for (const data of [{ data: [] }, { data: {} }, { data: [{ id: "actual-business-phone", display_phone_number: "+1 555 664 0296" }] },
    { data: [{ id: REVIEW_SANDBOX.phoneId, display_phone_number: "+971 54 442 6461" }] }]) {
    let calls = 0;
    await assert.rejects(performReviewAction("send_hello_world", randomUUID(), { env: environment(), clock: () => now, fetchImpl: async () => { calls++; return json(data); } }), failure("sandbox_binding_failed"));
    assert.equal(calls, 1);
  }
});

test("the send operation uses only the fixed test sender, fixed recipient and official hello_world template", async () => {
  const calls = []; const env = environment();
  const result = await performReviewAction("send_hello_world", randomUUID(), { env, clock: () => now, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return json(calls.length === 1 ? phones() : { messages: [{ id: "wamid.review-message-1" }] });
  } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith(`https://graph.facebook.com/v26.0/${REVIEW_SANDBOX.wabaId}/phone_numbers?`));
  assert.equal(calls[1].url, `https://graph.facebook.com/v26.0/${REVIEW_SANDBOX.phoneId}/messages`);
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body, { messaging_product: "whatsapp", to: REVIEW_SANDBOX.recipient, type: "template", template: { name: "hello_world", language: { code: "en_US" } },
    appsecret_proof: createHmac("sha256", env.WHATSAPP_APP_SECRET).update(env.WHATSAPP_REVIEW_ACCESS_TOKEN).digest("hex") });
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${env.WHATSAPP_REVIEW_ACCESS_TOKEN}`);
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(result.delivery, "accepted_by_meta_not_confirmed_on_recipient");
  assert.equal(JSON.stringify(result).includes(env.WHATSAPP_REVIEW_ACCESS_TOKEN), false);
});

test("creating a template addresses only the fixed test WABA and never calls messages", async () => {
  const calls = []; const id = randomUUID();
  const result = await performReviewAction("create_template", id, { env: environment(), clock: () => now, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return json(calls.length === 1 ? phones() : { id: "123456", status: "PENDING" });
  } });
  assert.equal(calls[1].url, `https://graph.facebook.com/v26.0/${REVIEW_SANDBOX.wabaId}/message_templates`);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.name, `newme_review_enquiry_${id.replaceAll("-", "")}`);
  assert.equal(body.category, "UTILITY"); assert.equal(body.language, "en_US");
  assert.deepEqual(body.components, [{ type: "BODY", text: REVIEW_TEMPLATE_BODY }]);
  assert.equal(result.template_status, "PENDING");
  assert.equal(calls.some(call => call.url.endsWith("/messages")), false);
});

test("connection checks do not issue a mutation", async () => {
  let calls = 0;
  const result = await performReviewAction("check_connection", randomUUID(), { env: environment(), clock: () => now, fetchImpl: async (_url, init) => {
    calls++; assert.equal(init.method, "GET"); return json(phones());
  } });
  assert.equal(calls, 1); assert.equal(result.ok, true);
});

test("expiry while the binding lookup is pending prevents either mutation at or after the deadline", async () => {
  for (const action of ["send_hello_world", "create_template"]) {
    for (const offset of [0, 1]) {
      const env = environment();
      const expiry = Date.parse(env.WHATSAPP_REVIEW_TOOLS_UNTIL);
      let currentTime = expiry - 1;
      const calls = [];
      let releaseLookup;
      const lookupPending = new Promise(resolve => { releaseLookup = resolve; });
      let markLookupStarted;
      const lookupStarted = new Promise(resolve => { markLookupStarted = resolve; });
      const operation = performReviewAction(action, randomUUID(), {
        env, clock: () => currentTime,
        fetchImpl: async (_url, init) => {
          calls.push(init.method);
          markLookupStarted();
          await lookupPending;
          return json(phones());
        },
      });
      const refused = assert.rejects(operation, error => error instanceof ReviewToolsError
        && error.code === "review_tools_disabled" && error.status === 503 && error.uncertain === false);
      await lookupStarted;
      currentTime = expiry + offset;
      releaseLookup();
      await refused;
      assert.deepEqual(calls, ["GET"], `${action}, deadline offset ${offset}`);
    }
  }
});

test("network loss and upstream 5xx after a mutation are uncertain and never auto-retried", async () => {
  for (const kind of ["network", "server", "oversize", "malformed", "secret_echo"]) {
    let calls = 0; const env = environment();
    try {
      await performReviewAction("send_hello_world", randomUUID(), { env, clock: () => now, fetchImpl: async () => {
        calls++; if (calls === 1) return json(phones());
        if (kind === "network") throw new Error(`private detail ${env.WHATSAPP_REVIEW_ACCESS_TOKEN}`);
        if (kind === "server") return json({ error: { code: 2, message: env.WHATSAPP_APP_SECRET } }, 500);
        if (kind === "oversize") return new Response("x".repeat(65_537));
        if (kind === "secret_echo") return json({ messages: [{ id: `wamid.${env.WHATSAPP_REVIEW_ACCESS_TOKEN}` }] });
        return new Response("not-json");
      } });
      assert.fail("must refuse an unconfirmed result");
    } catch (error) {
      assert.equal(error.uncertain, true, kind);
      assert.equal(error.message.includes(env.WHATSAPP_REVIEW_ACCESS_TOKEN), false);
      assert.equal(error.message.includes(env.WHATSAPP_APP_SECRET), false);
    }
    assert.equal(calls, 2);
  }
});

test("same-process concurrent retries share the original attempt, including uncertain failures", async () => {
  let calls = 0; const id = randomUUID();
  const work = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, action: "send_hello_world" }; };
  await Promise.all([runReviewAttempt("admin", "send_hello_world", id, work), runReviewAttempt("admin", "send_hello_world", id.toUpperCase(), work)]);
  assert.equal(calls, 1);
  await assert.rejects(runReviewAttempt("another-admin", "send_hello_world", id, work), failure("request_id_conflict"));
  const failedId = randomUUID(); let failures = 0;
  const failing = () => { failures++; throw new ReviewToolsError("meta_result_unknown", { uncertain: true }); };
  for (let i = 0; i < 2; i++) await assert.rejects(runReviewAttempt("admin", "create_template", failedId, failing), failure("meta_result_unknown"));
  assert.equal(failures, 1);
});

const require = createRequire(import.meta.url);
function loadRoute(mocks) {
  const ts = require("typescript");
  const out = ts.transpileModule(fs.readFileSync(new URL("../../src/app/api/whatsapp/review-tools/route.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}; new Function("require", "exports", out)((name) => mocks[name] ?? require(name), exports); return exports;
}
test("route denies other roles, cross-site calls, extra targets, malformed IDs and oversized bodies before Graph", async () => {
  const saved = { ...process.env }; let role = "sales"; let graphCalls = 0;
  const route = loadRoute({ "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": { getRequestAuthContext: async () => ({ role, user: { id: "user-1" } }), applyRequestAuthCookies: (_context, response) => response, RequestAuthError: class extends Error {} },
    "@/lib/rate-limit": { consumeRateLimit: () => ({ allowed: true }) },
    "@/lib/whatsapp-review-tools.mjs": { ...require("../../src/lib/whatsapp-review-tools.mjs"), reviewToolsConfig: () => ({ enabled: true }), performReviewAction: async () => { graphCalls++; return { ok: true }; } },
  });
  const request = (body = { action: "send_hello_world", request_id: randomUUID() }, headers = {}) => new Request("https://app.newme.ae/api/whatsapp/review-tools", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://app.newme.ae", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    for (role of ["sales", "operator", "finance"]) assert.equal((await route.POST(request())).status, 403);
    role = "admin";
    assert.equal((await route.POST(request(undefined, { origin: "https://untrusted.example" }))).status, 403);
    assert.equal((await route.POST(request(undefined, { "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal((await route.POST(request({ action: "send_hello_world", request_id: randomUUID(), to: "arbitrary-recipient" }))).status, 400);
    assert.equal((await route.POST(request({ action: "send_hello_world", request_id: "bad-id" }))).status, 400);
    assert.equal((await route.POST(request("x".repeat(1025)))).status, 413);
    assert.equal((await route.POST(request("{"))).status, 400);
    assert.equal(graphCalls, 0);
    assert.equal((await route.POST(request())).status, 200); assert.equal(graphCalls, 1);
  } finally { process.env = saved; }
});

test("disabled access, exhausted budgets and expired sessions stop before any Graph call; readiness does not disclose credentials", async () => {
  let enabled = false; let budget = true; let expired = false; let calls = 0;
  class AuthFailure extends Error {}
  const mocks = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": {
      getRequestAuthContext: async () => { if (expired) throw new AuthFailure(); return { role: "admin", user: { id: "budget-user" } }; },
      applyRequestAuthCookies: (_context, response) => response, RequestAuthError: AuthFailure,
      requestAuthErrorResponse: () => Response.json({ error: "session_expired" }, { status: 401 }),
    },
    "@/lib/rate-limit": { consumeRateLimit: () => ({ allowed: budget }) },
    "@/lib/whatsapp-review-tools.mjs": { ...require("../../src/lib/whatsapp-review-tools.mjs"), reviewToolsConfig: () => ({ enabled, until: null }), performReviewAction: async () => { calls++; return { ok: true }; } },
  };
  const route = loadRoute(mocks);
  const request = () => new Request("https://app.newme.ae/api/whatsapp/review-tools", { method: "POST", headers: { origin: "https://app.newme.ae", "Content-Type": "application/json" }, body: JSON.stringify({ action: "send_hello_world", request_id: randomUUID() }) });
  assert.equal((await route.POST(request())).status, 503);
  const readiness = await route.GET(new Request("https://app.newme.ae/api/whatsapp/review-tools"));
  assert.equal(readiness.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await readiness.json(), { enabled: false, until: null, template_body: REVIEW_TEMPLATE_BODY });
  enabled = true; budget = false;
  assert.equal((await route.POST(request())).status, 429);
  expired = true;
  assert.equal((await route.POST(request())).status, 401);
  assert.equal((await route.GET(new Request("https://app.newme.ae/api/whatsapp/review-tools"))).status, 401);
  assert.equal(calls, 0);
});
