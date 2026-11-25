// S43 (B12): the read-only WhatsApp conversation card and its API; a hand-logged WhatsApp contact counts as the
// first reply in the follow-up monitor. The loader replaces Module._load for one load, so the runner gives
// this file its own process.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { evaluateFollowup, manualWhatsAppEvents, resolveFollowupConfig } from "../../src/lib/followup-monitor.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain));
  try { loaded._compile(outputText, filename); return loaded.exports; } finally { Module._load = previousLoad; }
}

const dubai = (day, hm) => new Date(`${day}T${hm}:00+04:00`).toISOString();
const LEAD = "0000000000-0000-4000-8000-0000000000a1".replace("0000000000", "00000000");
const USER = "00000000-0000-4000-8000-0000000000b1";

class RequestAuthError extends Error {}

function loadRoute({ visible, conversations = [], events = [] }) {
  const adminCalls = [];
  const admin = {
    from(table) {
      const filters = [];
      const builder = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            adminCalls.push(table);
            const data = table === "whatsapp_conversations" ? conversations : table === "whatsapp_message_events" ? [...events].reverse() : [];
            return (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject);
          }
          return (...args) => { filters.push([prop, ...args]); return builder; };
        },
      });
      return builder;
    },
  };
  const context = {
    role: "sales", user: { id: USER },
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: visible ? { id: LEAD } : null, error: null }) }) }) }) },
  };
  const route = loadModule("src/app/api/leads/[id]/whatsapp-messages/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body }) } },
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/logger": { logger: { error() {}, info() {}, warn() {} } },
    "@/lib/request-auth-context": {
      getRequestAuthContext: async () => context, applyRequestAuthCookies: (_c, r) => r, RequestAuthError,
      requestAuthErrorResponse: () => ({ status: 401, body: {} }),
    },
  });
  const call = (id = LEAD) => route.GET(new Request(`http://localhost/api/leads/${id}/whatsapp-messages`), { params: Promise.resolve({ id }) });
  return { call, adminCalls };
}

test("a lead RLS does not show the caller is refused before any service-role read", async () => {
  const { call, adminCalls } = loadRoute({ visible: false, conversations: [{ id: "c1" }] });
  const response = await call();
  assert.equal(response.status, 403);
  assert.equal(adminCalls.length, 0);
  assert.equal((await loadRoute({ visible: true }).call("not-a-uuid")).status, 404);
});

test("a visible lead gets its stored messages, oldest first, with the text; no conversation says so", async () => {
  const events = [
    { id: "m1", direction: "inbound", occurred_at: dubai("2026-11-20", "10:00"), body: "Hi, I saw your ad", body_kind: "text", message_type: "text", backfilled: false },
    { id: "m2", direction: "outbound", occurred_at: dubai("2026-11-20", "10:20"), body: "Hello! Which villa?", body_kind: "text", message_type: "text", backfilled: false },
  ];
  const { call } = loadRoute({ visible: true, conversations: [{ id: "c1" }], events });
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.body.has_conversation, true);
  assert.deepEqual(response.body.messages.map((m) => m.id), ["m1", "m2"]);
  assert.equal(response.body.messages[0].body, "Hi, I saw your ad");
  const none = await loadRoute({ visible: true, conversations: [] }).call();
  assert.deepEqual(none.body, { has_conversation: false, messages: [] });
});

test("the card is mounted on the lead page beside the follow-up card, folds by default, and hides without a conversation", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /<LeadFollowupCard lead=\{lead\} t=\{t\} \/>\s*\n\s*<LeadWhatsAppConversationCard lead=\{lead\} t=\{t\} \/>/);
  const card = read("src/app/(dashboard)/leads/[id]/LeadWhatsAppConversationCard.tsx");
  assert.match(card, /if \(!isWhatsApp \|\| failed \|\| !data \|\| !data\.has_conversation\) return null;/);
  assert.match(card, /useState\(false\)/);
  assert.match(card, /data-testid="whatsapp-conversation-card"/);
  assert.doesNotMatch(card, /method: "POST"/);
  const route = read("src/app/api/leads/[id]/whatsapp-messages/route.ts");
  assert.match(route, /private, no-store/);
  assert.ok(route.indexOf("canSeeLead(context, leadId)") < route.indexOf('supabaseAdmin\n      .from("whatsapp_conversations")'));
});

test("a WhatsApp contact logged by hand counts as the first reply", () => {
  const config = resolveFollowupConfig({});
  const inbound = { direction: "inbound", occurredAt: dubai("2026-11-18", "10:05") };
  const logs = [{ contact_type: "whatsapp", contact_time: dubai("2026-11-18", "10:40") }, { contact_type: "phone", contact_time: dubai("2026-11-18", "10:10") }];
  const manual = manualWhatsAppEvents(logs);
  assert.equal(manual.length, 1);
  assert.equal(manual[0].direction, "outbound");
  const without = evaluateFollowup({ events: [inbound], now: dubai("2026-11-18", "15:00"), config });
  const withLog = evaluateFollowup({ events: [inbound, ...manual], now: dubai("2026-11-18", "15:00"), config });
  assert.equal(without.firstReplyAt, null);
  assert.equal(without.state, "overdue");
  assert.equal(withLog.firstReplyAt, dubai("2026-11-18", "10:40"));
  assert.equal(withLog.firstResponseMinutes, 35);
  assert.equal(withLog.state, "normal");
  const cron = read("src/app/api/cron/check-whatsapp-followups/route.ts");
  assert.match(cron, /from\("follow_up_logs"\)[\s\S]*eq\("contact_type", "whatsapp"\)/);
  assert.match(cron, /\.\.\.manualWhatsAppEvents\(manualByLead\.get\(lead\.id\)/);
});
