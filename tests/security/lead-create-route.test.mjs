// S3 #4/#5/#8 — POST /api/leads. Lead creation used to be a direct browser
// insert: empty leads, letters as phone numbers, the same phone twice with no
// warning, and four managers notified about every new lead. The route
// validates, stores the phone in E.164, refuses a duplicate unless an
// admin/boss/operator overrides it with a reason (audited), and notifies only
// the assignee (or the admin/operator queue for an unassigned lead).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTE = "src/app/api/leads/route.ts";
const SALES = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function loadTs(file, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, file);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const contact = await import("../../src/lib/lead-contact.mjs");
  const candidates = await import("../../src/lib/lead-transfer-candidates.mjs");
  const all = { "@/lib/lead-contact.mjs": contact, "@/lib/lead-transfer-candidates.mjs": candidates, "@supabase/supabase-js": {}, ...mocks };
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previous = Module._load;
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(all, request)) return all[request];
    if (request.startsWith("@/")) throw new Error(`unexpected import ${request}`);
    return previous.call(Module, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previous;
  }
}

const loadRoute = async (mocks) => loadTs(ROUTE, {
  ...mocks,
  "@/lib/lead-duplicates": await loadTs("src/lib/lead-duplicates.ts", {}),
});

function setup({ role = "sales", existing = [] } = {}) {
  const writes = { leads: [], business_events: [], follow_up_logs: [], notifications: [] };
  const session = {
    from(table) {
      return {
        insert(row) { writes[table].push(row); return this; },
        select() { return this; },
        async single() { return { data: { id: "new-lead", customer_name: writes.leads.at(-1)?.customer_name, assigned_to: writes.leads.at(-1)?.assigned_to }, error: null }; },
        then(resolve) { return resolve({ error: null }); },
      };
    },
  };
  const admin = {
    from() {
      const q = {
        select() { return q; },
        ilike() { return q; },
        async limit() { return { data: existing, error: null }; },
      };
      return q;
    },
  };
  class MockAuthError extends Error {}
  const mocks = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_c, r) => r,
      getRequestAuthContext: async () => ({ supabase: session, user: { id: SALES }, role, profile: { is_active: true } }),
      RequestAuthError: MockAuthError,
      requestAuthErrorResponse: () => Response.json({}, { status: 401 }),
    },
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/tasks": { createFollowUpTask: async () => ({ error: null }) },
    "@/lib/notification-events": {
      leadCreatedDrafts: async (_db, lead) => [{ userId: lead.assigned_to ?? "queue", title: "t" }],
      duplicateReviewDrafts: async () => [{ userId: "review-queue", title: "review" }],
    },
    "@/lib/notifications": { createNotificationsBulk: async (drafts) => { writes.notifications.push(...drafts); } },
  };
  return { writes, mocks };
}

const post = (body) => new Request("https://app.newme.ae/api/leads", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("an empty lead and a phone made of letters are refused", async () => {
  const { writes, mocks } = setup();
  const { POST } = await loadRoute(mocks);
  const empty = await POST(post({}));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).errors.customer_name, "required");
  const letters = await POST(post({ customer_name: "Ahmed", phone: "abcdefg" }));
  assert.equal(letters.status, 400);
  assert.equal((await letters.json()).errors.phone, "invalid");
  assert.equal(writes.leads.length, 0);
});

test("a local UAE number is stored in E.164 and only the assignee is notified", async () => {
  const { writes, mocks } = setup();
  const { POST } = await loadRoute(mocks);
  const response = await POST(post({ customer_name: "Ahmed", phone: "050-123 4567" }));
  assert.equal(response.status, 201);
  assert.equal(writes.leads[0].phone, "+971501234567");
  assert.equal(writes.leads[0].assigned_to, SALES);
  assert.deepEqual(writes.notifications.map((n) => n.userId), [SALES]);
});

test("sales: a duplicate in another format warns without any detail of a lead they cannot see", async () => {
  const existing = [{ id: "old-lead", customer_name: "Ahmed Secret", phone: "00971501234567", email: null, assigned_to: OTHER, archived: true }];
  const { writes, mocks } = setup({ existing });
  const { POST } = await loadRoute(mocks);
  const response = await POST(post({ customer_name: "Ahmed B", phone: "+971 50 123 4567" }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "DUPLICATE_LEAD");
  assert.equal(body.reviewRequired, true);
  assert.equal(body.canOverride, true);
  const text = JSON.stringify(body.duplicates);
  for (const secret of ["old-lead", "Ahmed Secret", OTHER, "00971", "true", "phone"]) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(writes.leads.length, 0);
  const noReason = await POST(post({ customer_name: "Ahmed B", phone: "0501234567", duplicateOverride: { reason: " " } }));
  assert.equal(noReason.status, 400);
});

test("sales may still create with a reason; the lead is flagged and sent to the admin/operator review queue", async () => {
  const existing = [{ id: "old-lead", customer_name: "Ahmed", phone: "+971501234567", email: null, assigned_to: OTHER, archived: false }];
  const { writes, mocks } = setup({ existing });
  const { POST } = await loadRoute(mocks);
  const response = await POST(post({ customer_name: "Ahmed B", phone: "0501234567", duplicateOverride: { reason: "second villa" } }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).flaggedForReview, true);
  assert.equal(writes.leads[0].sales_manager_review, true);
  assert.equal(writes.business_events[0].event_data.review_required, true);
  assert.ok(writes.notifications.some((n) => n.userId === "review-queue"), "admin/operator review queue notified");
});

test("an operator may override a duplicate with a reason, and the override is audited", async () => {
  const existing = [{ id: "old-lead", customer_name: "Ahmed", phone: "+971501234567", email: null, assigned_to: OTHER, archived: false }];
  const { writes, mocks } = setup({ role: "operator", existing });
  const { POST } = await loadRoute(mocks);
  const noReason = await POST(post({ customer_name: "Ahmed B", phone: "0501234567", duplicateOverride: { reason: "" } }));
  assert.equal(noReason.status, 400);
  const response = await POST(post({ customer_name: "Ahmed B", phone: "0501234567", duplicateOverride: { reason: "second villa" } }));
  assert.equal(response.status, 201);
  assert.equal(writes.business_events.length, 1);
  assert.deepEqual(writes.business_events[0].event_data.duplicate_lead_ids, ["old-lead"]);
  assert.equal(writes.business_events[0].event_data.reason, "second villa");
  assert.equal(writes.leads[0].sales_manager_review, undefined, "an operator's own override needs no review");
  assert.equal(writes.notifications.some((n) => n.userId === "review-queue"), false);
});
