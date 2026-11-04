// S7 / review 5-logging-monitoring F5: Meta lead intake failures used to be
// swallowed (`catch {}`), so a failed Graph fetch or a rejected signature left no
// trace. Each failure must now log a PII-free reason code at error level (which
// the logger forwards to Sentry) while the HTTP behaviour stays unchanged.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { leadgenFailureReason } from "../../src/lib/meta-leadgen-failure.mjs";

const require = createRequire(import.meta.url);
const PAGE = "123456789012345";
const LEAD = "9876543210987654";
const SECRET = "app-secret-value";
const TOKEN = "graph-token-value";

function loadRoute(mocks) {
  const ts = require("typescript");
  const file = new URL("../../src/app/api/meta/leadgen-webhook/route.ts", import.meta.url);
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}

test("reason codes are stable and never echo free text", () => {
  assert.equal(leadgenFailureReason(new Error("graph_error_190")), "graph_error_190");
  assert.equal(leadgenFailureReason(new Error("lead_insert_failed")), "lead_insert_failed");
  assert.equal(leadgenFailureReason(new Error("Bearer abc.def.ghi leaked")), "unexpected_error");
  assert.equal(leadgenFailureReason(new Error("Fatima 0501234567")), "unexpected_error");
  assert.equal(leadgenFailureReason("string"), "unexpected_error");
});

test("webhook logs a reason code for signature and Graph failures, without secrets or lead data", async () => {
  const lib = await import("../../src/lib/meta-lead-ads.mjs");
  const logs = [];
  const sink = (level) => (...args) => logs.push([level, ...args]);
  const route = loadRoute({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/supabase-admin": { supabaseAdmin: {} },
    "@/lib/meta-crm-events": { enqueueMetaCrmStageEvent: async () => "queued" },
    "@/lib/meta-lead-ads.mjs": lib,
    "@/lib/meta-leadgen-failure.mjs": { leadgenFailureReason },
    "@/lib/logger": { logger: { info: sink("info"), warn: sink("warn"), error: sink("error") } },
  });
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, { META_LEADGEN_ENABLED: "true", META_LEADGEN_VERIFY_TOKEN: "v",
    META_APP_SECRET: SECRET, META_LEADS_ACCESS_TOKEN: TOKEN, META_LEADGEN_PAGE_IDS: PAGE });
  try {
    lib.clearPageTokenCache();
    const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, changes: [{ field: "leadgen", value: { page_id: PAGE, leadgen_id: LEAD } }] }] });
    const post = (sig) => new Request("https://example.test/api/meta/leadgen-webhook?hub.verify_token=zzz", {
      method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw });

    assert.equal((await route.POST(post("sha256=" + "0".repeat(64)))).status, 403);
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 190, message: `token ${TOKEN} expired for Fatima` } }) });
    const good = "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
    assert.equal((await route.POST(post(good))).status, 503);

    const errors = logs.filter(([level]) => level === "error");
    const codes = errors.map(([, ctx]) => ctx.code);
    assert.deepEqual(codes, ["invalid_signature", "graph_error_190"]);
    const serialized = JSON.stringify(logs);
    for (const leaked of [SECRET, TOKEN, LEAD, "Fatima", "zzz"]) assert.ok(!serialized.includes(leaked), `log leaked ${leaked}`);
    assert.ok(errors.every(([, , message]) => typeof message === "string" && message.startsWith("meta leadgen failure:")));
  } finally {
    process.env = saved;
    globalThis.fetch = savedFetch;
    lib.clearPageTokenCache();
  }
});
