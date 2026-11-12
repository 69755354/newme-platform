// S3 #1 — completing milestones never advanced the lead stage: a lead with all
// seven milestones done still showed "New lead" on the kanban and in every
// stage-based number. The milestone route now, after the milestone write
// succeeded, moves the stage forward through the existing audited
// transition_lead_stage() routine, one step per call, per the milestone ->
// stage mapping the app already reports to Meta. It never fails the save:
// the first-contact gate, a missing next follow-up (trg_enforce_followup would
// reject the update), terminal leads and refusals come back as a hint.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEAD = "55555555-5555-4555-8555-555555555555";
const SALES = "11111111-1111-4111-8111-111111111111";

function loadTs(file, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, file);
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

const advance = await import("../../src/lib/milestone-stage-advance.mjs");
const gate = await import("../../src/lib/first-contact-gate.mjs");
const milestones = loadTs("src/lib/milestones.ts", {});

/** A session client: one lead, its contacts and milestones; rpc calls recorded. */
function world({ lead, contacts = [], milestonesDone = [], rpcError = null }) {
  const state = { lead: { ...lead }, rpc: [], meta: [] };
  const query = (table) => {
    const q = {
      _table: table,
      select() { return q; },
      eq() { return q; },
      order() { return q; },
      insert(row) { q._insert = row; return q; },
      update() { return q; },
      async single() {
        if (table === "leads") return { data: { id: LEAD, current_milestone: null, ...state.lead }, error: null };
        if (table === "lead_milestones" && q._insert) return { data: { id: "m-new", ...q._insert }, error: null };
        return { data: null, error: null };
      },
      then(resolve) {
        if (table === "follow_up_logs") return resolve({ data: contacts, error: null });
        if (table === "lead_milestones") {
          return resolve({ data: milestonesDone.map((key) => ({ milestone_key: key, completed_at: "2026-11-01T00:00:00Z", notes: "n" })), error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return q;
  };
  const supabase = {
    from: query,
    async rpc(name, args) {
      state.rpc.push([name, args]);
      if (rpcError) return { data: null, error: { message: rpcError } };
      state.lead.stage = args.p_next_stage;
      return { data: { id: LEAD, stage: args.p_next_stage }, error: null };
    },
  };
  return { state, supabase };
}

function route(w, role = "sales") {
  class MockAuthError extends Error {}
  return loadTs("src/app/api/leads/[id]/milestone/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/supabase-admin": { supabaseAdmin: {} },
    "@/lib/milestones": milestones,
    "@/lib/meta-crm-events": {
      enqueueMetaCrmEventForLead: async (_db, _id, key) => { w.state.meta.push(key); },
    },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_c, r) => r,
      getRequestAuthContext: async () => ({ supabase: w.supabase, user: { id: SALES }, role }),
      RequestAuthError: MockAuthError,
      requestAuthErrorResponse: () => Response.json({}, { status: 401 }),
    },
    "@/lib/first-contact-gate.mjs": gate,
    "@/lib/milestone-stage-advance.mjs": advance,
  });
}

const complete = (w, milestoneKey, role) => route(w, role).POST(
  new Request(`https://app.newme.ae/api/leads/${LEAD}/milestone`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ milestoneKey, notes: "done" }),
  }),
  { params: Promise.resolve({ id: LEAD }) },
);

const ready = {
  assigned_to: SALES, stage: "new", final_status: null, quality: "good",
  next_action: "call", next_followup_date: "2026-11-10",
};
const contact = [{ contact_time: "2026-11-01T10:00:00Z", contact_result: "answered" }];

test("completing First Contact moves a ready lead from new to contacted via transition_lead_stage", async () => {
  const w = world({ lead: ready, contacts: contact });
  const response = await complete(w, "first_contact");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(w.state.rpc.map(([name, a]) => [name, a.p_expected_stage, a.p_next_stage]), [
    ["transition_lead_stage", "new", "contacted"],
  ]);
  assert.match(w.state.rpc[0][1].p_idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(body.stageAdvance, { advanced: true, stage: "contacted", reason: null });
  assert.deepEqual(w.state.meta, ["first_contact"], "only the milestone's Meta event, no second stage event");
});

test("a lead stuck at new walks one audited step at a time up to the milestone's stage", async () => {
  const w = world({ lead: ready, contacts: contact, milestonesDone: ["first_contact", "basic_info", "drawings"] });
  const response = await complete(w, "requirements");
  assert.equal(response.status, 200);
  assert.deepEqual(w.state.rpc.map(([, a]) => `${a.p_expected_stage}->${a.p_next_stage}`), [
    "new->contacted", "contacted->requirement_confirmed",
  ]);
});

test("milestones without a stage of their own and leads already further on are left alone", async () => {
  const w = world({ lead: { ...ready, stage: "contacted" }, contacts: contact, milestonesDone: ["first_contact"] });
  assert.equal((await complete(w, "basic_info")).status, 200);
  const past = world({ lead: { ...ready, stage: "negotiation" }, milestonesDone: ["first_contact", "basic_info", "drawings", "requirements", "solution"] });
  assert.equal((await complete(past, "quotation")).status, 200);
  assert.deepEqual([...w.state.rpc, ...past.state.rpc], []);
});

test("missing next action / follow-up date: the milestone still saves, the stage stays, a hint is returned", async () => {
  const w = world({ lead: { ...ready, next_followup_date: null }, contacts: contact });
  const response = await complete(w, "first_contact");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(w.state.rpc, []);
  assert.deepEqual(body.stageAdvance, { advanced: false, stage: "new", reason: "next_followup_required" });
});

test("a refused or failed stage change never fails the milestone save", async () => {
  const w = world({ lead: ready, contacts: contact, rpcError: "Forbidden: invalid CRM role" });
  const response = await complete(w, "first_contact", "operator");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stageAdvance.reason, "not_permitted");
});

test("planning rules: gate, terminal, idempotent keys", () => {
  const base = { stage: "new", finalStatus: null, milestoneKey: "first_contact", quality: "good", hasCompleteContact: true, nextAction: "call", nextFollowupDate: "2026-11-10" };
  assert.deepEqual(advance.planStageStep(base), { next: "contacted" });
  assert.deepEqual(advance.planStageStep({ ...base, quality: "pending" }), { next: null, reason: "first_contact_gate" });
  assert.deepEqual(advance.planStageStep({ ...base, hasCompleteContact: false }), { next: null, reason: "first_contact_gate" });
  assert.deepEqual(advance.planStageStep({ ...base, finalStatus: "lost" }), { next: null, reason: null });
  assert.deepEqual(advance.planStageStep({ ...base, stage: "won" }), { next: null, reason: null });
  assert.equal(advance.stageStepKey(LEAD, "first_contact", "contacted"), advance.stageStepKey(LEAD, "first_contact", "contacted"));
  assert.notEqual(advance.stageStepKey(LEAD, "first_contact", "contacted"), advance.stageStepKey(LEAD, "requirements", "contacted"));
});

test("the mapping is the app's milestone -> stage mapping (same Meta funnel event)", () => {
  const source = fs.readFileSync(path.join(root, "src/lib/meta-crm-events.ts"), "utf8");
  const events = Object.fromEntries([...source.matchAll(/^\s+(\w+): "([^"]+)",$/gm)].map((m) => [m[1], m[2]]));
  for (const [milestone, stage] of Object.entries(advance.MILESTONE_STAGE)) {
    assert.ok(events[milestone], milestone);
    assert.equal(events[milestone], events[stage], `${milestone} and ${stage} must report the same funnel event`);
  }
});

// S16: the audit note defaults to the milestone text, and a caller that advances the
// stage for another reason (the quotation route) passes its own.
test("advanceStageForMilestone writes 'Milestone completed: <key>' by default and an optional note when given", async () => {
  const calls = [];
  const supabase = { rpc: async (_name, args) => { calls.push(args.p_note); return { data: { stage: args.p_next_stage }, error: null }; } };
  const lead = { stage: "solution_submitted", final_status: null, quality: "good", next_action: "call", next_followup_date: "2026-11-10" };
  await advance.advanceStageForMilestone(supabase, { leadId: LEAD, milestoneKey: "quotation", lead, hasCompleteContact: true });
  await advance.advanceStageForMilestone(supabase, { leadId: LEAD, milestoneKey: "quotation", lead, hasCompleteContact: true, note: "Quotation generated NM-1" });
  await advance.advanceStageForMilestone(supabase, { leadId: LEAD, milestoneKey: "quotation", lead, hasCompleteContact: true, note: "   " });
  assert.deepEqual(calls, ["Milestone completed: quotation", "Quotation generated NM-1", "Milestone completed: quotation"]);
});
