// S3 #2 — "Lead not found" after a successful save.
// POST /api/leads/[id]/events built its own Supabase client with the library's
// default cookie names; the app's session cookies are custom-named, so the
// client was anonymous, RLS hid the lead, and the audit event always answered
// 404 right after the real save. The route must use the shared request auth
// context (the same session every other lead route uses).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTE = "src/app/api/leads/[id]/events/route.ts";
const LEAD = "55555555-5555-4555-8555-555555555555";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function loadRoute(mocks) {
  const ts = require("typescript");
  const filename = path.join(root, ROUTE);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previous = Module._load;
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    if (request.startsWith("@/") || request === "@supabase/ssr") {
      throw new Error(`unexpected import ${request}`);
    }
    return previous.call(Module, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previous;
  }
}

function sessionClient({ leadOwner = OWNER, insertError = null } = {}) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      if (table === "leads") {
        return {
          select() { return this; },
          eq() { return this; },
          async single() { return { data: { id: LEAD, assigned_to: leadOwner }, error: null }; },
        };
      }
      assert.equal(table, "business_events");
      return {
        insert(row) { inserts.push(row); return this; },
        select() { return this; },
        async single() { return insertError ? { data: null, error: insertError } : { data: { id: "evt-1" }, error: null }; },
      };
    },
  };
}

function route(client, role = "sales", userId = OWNER) {
  class MockAuthError extends Error {}
  return loadRoute({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_context, response) => response,
      getRequestAuthContext: async () => ({ supabase: client, user: { id: userId }, role, refreshedCookies: [] }),
      RequestAuthError: MockAuthError,
      requestAuthErrorResponse: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    },
  });
}

const post = (body) => new Request(`https://app.newme.ae/api/leads/${LEAD}/events`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: "newme-auth=session" },
  body: JSON.stringify(body),
});
const params = { params: Promise.resolve({ id: LEAD }) };

test("the follow-up audit event is written with the caller's real session", async () => {
  const client = sessionClient();
  const response = await route(client).POST(
    post({ eventType: "followup_scheduled", description: "Next action updated: call", eventData: { due_at: "2026-11-10" } }),
    params,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, eventId: "evt-1" });
  assert.equal(client.inserts.length, 1);
  assert.equal(client.inserts[0].user_id, OWNER);
  assert.equal(client.inserts[0].event_type, "followup_scheduled");
});

test("admin and operator may record events on any lead; another salesperson may not", async () => {
  for (const role of ["admin", "boss", "operator"]) {
    const response = await route(sessionClient({ leadOwner: OTHER }), role).POST(
      post({ eventType: "note_added", description: "x" }), params,
    );
    assert.equal(response.status, 200, role);
  }
  const forbidden = await route(sessionClient({ leadOwner: OTHER }), "sales").POST(
    post({ eventType: "note_added", description: "x" }), params,
  );
  assert.equal(forbidden.status, 403);
});

test("a real write failure is still reported as a failure", async () => {
  const response = await route(sessionClient({ insertError: { message: "denied" } })).POST(
    post({ eventType: "note_added", description: "x" }), params,
  );
  assert.equal(response.status, 500);
});
