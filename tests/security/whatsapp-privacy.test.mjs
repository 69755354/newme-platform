import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { deletionCustomerKey, readDeletionInput } from "../../src/lib/whatsapp-privacy.mjs";
import { runWhatsAppMaintenance } from "../../scripts/whatsapp-privacy-maintenance.mjs";

const id = "f0000000-0000-4000-8000-000000000001";
const body = { phone: "+971 50 000 0001", request_id: id, verified: true };
const request = (value, headers = {}) => new Request("https://app.newme.ae/api/whatsapp/privacy", {
  method: "POST", body: typeof value === "string" ? value : JSON.stringify(value), headers,
});
test("deletion and webhook use the same salted international customer reference", () => {
  const expected = createHmac("sha256", "isolated-test-salt").update("971500000001").digest("hex");
  assert.equal(deletionCustomerKey(" +971 (50) 000-0001 ", "isolated-test-salt"), expected);
  assert.notEqual(deletionCustomerKey(body.phone, "different-salt"), expected);
  for (const phone of ["0500000001", "971500000001", "+000000000", "+12", "+971500000001x", "+1234567890123456", null]) {
    assert.equal(deletionCustomerKey(phone, "isolated-test-salt"), null);
  }
  assert.equal(deletionCustomerKey(body.phone, ""), null);
});
test("only explicit verified requests with opaque UUIDs are accepted", async () => {
  assert.deepEqual(await readDeletionInput(request(body)), body);
  for (const bad of [{ ...body, verified: false }, { ...body, verified: "true" }, { ...body, actor: "boss" },
    { ...body, customer_key: "a".repeat(64) }, { ...body, request_id: "caller-chosen-path" }, [], null, "{broken"]) {
    assert.equal(await readDeletionInput(request(bad)), null);
  }
});
test("bounded input rejects declared and streamed oversize before parsing", async () => {
  assert.equal(await readDeletionInput(request(body, { "content-length": "1025" })), null);
  assert.equal(await readDeletionInput(request({ ...body, phone: "1".repeat(1100) })), null);
});

const config = { url: "https://vfopmpxlhwzpxqegayew.supabase.co", key: "synthetic-test-value-not-a-credential" };
const receipt = { completed_at: "2026-10-22T19:00:00Z", deleted_expired: 2, completed_requests: 1, backlog: false };

test("scheduled worker executes through a release symlink but remains inert when imported", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "newme-wa-entry-"));
  try {
    const release = join(root, "release");
    const current = join(root, "current");
    fs.mkdirSync(release);
    fs.copyFileSync(new URL("../../scripts/whatsapp-privacy-maintenance.mjs", import.meta.url), join(release, "worker.mjs"));
    // Junction selects a directory link on Windows; other platforms ignore the type.
    fs.symlinkSync(release, current, "junction");
    const preload = join(root, "deny-root.mjs");
    // Stop at the first CLI guard: the child cannot read a real runtime file or call the network.
    fs.writeFileSync(preload, "process.getuid = () => 1000;\n");
    const worker = join(current, "worker.mjs");
    const cli = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, worker], { encoding: "utf8", timeout: 10_000 });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(cli.stdout, "");
    assert.match(cli.stderr, /^WHATSAPP_PRIVACY_MAINTENANCE_FAILED\r?\n$/);
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(worker).href)})`], { encoding: "utf8", timeout: 10_000 });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout + imported.stderr, "");
  } finally {
    assert.equal(fs.realpathSync(dirname(root)), fs.realpathSync(tmpdir()));
    assert.match(basename(root), /^newme-wa-entry-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("worker invokes only the fixed cleanup RPC and returns an allowlisted receipt", async () => {
  let calls = 0;
  const result = await runWhatsAppMaintenance({ ...config, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `${config.url}/rest/v1/rpc/maintain_whatsapp_privacy`);
    assert.equal(options.body, "{}"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${config.key}`);
    return Response.json({ ...receipt, unexpected_private_data: "must-not-escape" });
  } });
  assert.equal(calls, 1); assert.deepEqual(result, receipt);
});
test("worker drains bounded batches and refuses a continuing backlog", async () => {
  let calls = 0;
  await assert.rejects(runWhatsAppMaintenance({ ...config, fetchImpl: async () => {
    calls++; return Response.json({ ...receipt, backlog: true });
  } }), /privacy_maintenance_backlog/);
  assert.equal(calls, 5);
  calls = 0;
  assert.deepEqual(await runWhatsAppMaintenance({ ...config, fetchImpl: async () =>
    Response.json({ ...receipt, backlog: ++calls < 3 }) }), receipt);
  assert.equal(calls, 3);
});
test("worker never exposes provider errors or credentials", async () => {
  for (const fetchImpl of [async () => { throw new Error(config.key); },
    async () => new Response(config.key, { status: 500 }),
    async () => new Response(config.key),
    async () => Response.json({ ...receipt, deleted_expired: -1 })]) {
    await assert.rejects(runWhatsAppMaintenance({ ...config, fetchImpl }), error => {
      assert.doesNotMatch(error.message, /synthetic-test/); return /^privacy_maintenance_/.test(error.message);
    });
  }
  await assert.rejects(runWhatsAppMaintenance({ ...config, url: "https://unapproved.invalid", fetchImpl: () => assert.fail("network must not run") }), /configuration_invalid/);
});

test("HTTP deletion authenticates before parsing and sends only the server-derived key through the caller session", async () => {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const source = fs.readFileSync(new URL("../../src/app/api/whatsapp/privacy/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let role = "boss"; let authFailure = false; let failureCode = null; const calls = [];
  class RequestAuthError extends Error {}
  const mocks = {
    "next/server": { NextResponse: { json: (value, options) => Response.json(value, options) } },
    "@/lib/whatsapp-privacy.mjs": { deletionCustomerKey, readDeletionInput },
    "@/lib/request-auth-context": {
      getRequestAuthContext: async () => {
        if (authFailure) throw new RequestAuthError();
        return { role, supabase: { rpc: async (name, args) => {
          calls.push({ name, args }); return failureCode ? { error: { code: failureCode, message: "private provider diagnostic" } }
            : { data: name === "whatsapp_privacy_status" ? { healthy: true, receipts: [] } : { request_id: id, state: "completed", deleted_count: 0 } };
        } } };
      },
      applyRequestAuthCookies: (_context, response) => response,
      RequestAuthError, requestAuthErrorResponse: () => Response.json({ error: "not_authenticated" }, { status: 401 }),
    },
  };
  const route = {};
  new Function("require", "exports", compiled)(name => mocks[name] ?? require(name), route);
  const post = (headers = {}, value = body) => route.POST(request(value, {
    origin: "https://app.newme.ae", "content-type": "application/json", ...headers,
  }));
  const savedSalt = process.env.WHATSAPP_PILOT_CONTACT_SALT;
  try {
    process.env.WHATSAPP_PILOT_CONTACT_SALT = "synthetic-unit-test-salt";
    authFailure = true; assert.equal((await post()).status, 401); authFailure = false;
    for (role of ["sales", "finance", "operator"]) {
      assert.equal((await post()).status, 403);
      assert.equal((await route.GET(request(body))).status, 403);
    }
    role = "boss";
    assert.equal((await post({ origin: "https://other.invalid" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post({ "content-type": "text/plain" })).status, 415);
    assert.equal((await post({}, { ...body, verified: false })).status, 400);
    assert.equal((await post({}, { ...body, phone: "0500000001" })).status, 400);
    assert.equal(calls.length, 0);
    const response = await post();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.deepEqual(calls[0], { name: "request_whatsapp_deletion", args: {
      p_request_id: id, p_customer_key: deletionCustomerKey(body.phone, "synthetic-unit-test-salt"),
    } });
    assert.equal(JSON.stringify(calls).includes(body.phone), false);
    for (const [code, status] of [["42501", 403], ["22023", 409], ["54000", 429], ["57014", 503]]) {
      failureCode = code; const failure = await post(); assert.equal(failure.status, status);
      const result = await failure.json(); assert.equal(result.result_uncertain, status === 503);
      assert.equal(JSON.stringify(result).includes("private provider"), false);
    }
  } finally {
    if (savedSalt === undefined) delete process.env.WHATSAPP_PILOT_CONTACT_SALT;
    else process.env.WHATSAPP_PILOT_CONTACT_SALT = savedSalt;
  }
});
