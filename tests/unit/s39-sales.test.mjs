// S39 (UX batch 5, "sales want to use it every day"): quick actions, compact sortable list, relaxed stage rules,
// workbench inbox order, one phone reader for every entry point, WhatsApp ad badge and waiting state.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { intakePhone, normalizePhone, phoneIdentityKey } from "../../src/lib/lead-contact.mjs";
import { normalizeWhatsAppPhoneKey } from "../../src/lib/whatsapp-ctwa.mjs";
import { normalizePhone as sheetPhone } from "../../src/lib/drive-sync.mjs";
import { mapMetaLeadToRow, storeMetaLead } from "../../src/lib/meta-lead-ads.mjs";
import { leadGreetingLanguage, quickLogBody, whatsappGreeting, whatsappLinkWithGreeting } from "../../src/lib/lead-actions.mjs";
import { DEFAULT_LEAD_SORT, MOBILE_PAGE_SIZE, pageOf, parseLeadSort, sortLeads } from "../../src/lib/leads-sort.mjs";
import { completeFirstContactAfterLog } from "../../src/lib/contact-first-contact.mjs";
import { enqueueMetaCrmFunnelBetween } from "../../src/lib/meta-crm-events.ts";
import { funnelStagesBetween, planStageStep } from "../../src/lib/milestone-stage-advance.mjs";
import { evaluateFirstContactGate } from "../../src/lib/first-contact-gate.mjs";
import { isWaitingForReply, isWhatsAppAdLead } from "../../src/lib/whatsapp-ad-display.mjs";
import { INBOX_LIMIT, mergeInbox } from "../../src/lib/workbench-inbox.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { canCompleteMilestone } = (() => {
  const ts = require("typescript");
  const { outputText } = ts.transpileModule(read("src/lib/milestones.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  new Function("exports", outputText)(exports);
  return exports;
})();

// ── 1 & 2: quick actions ──────────────────────────────────────────────────────────────────────────────────────────
test("S39-1 call link is tel: in E.164, WhatsApp link carries the greeting with the customer's and salesperson's names", () => {
  const lead = { phone: "050 123 4567", customer_name: "Sara Khan", landing_page: "https://newme.ae/en/villas" };
  const link = whatsappLinkWithGreeting(lead, "Omar");
  assert.ok(link.startsWith("https://wa.me/971501234567?text="));
  const text = decodeURIComponent(link.split("?text=")[1]);
  assert.match(text, /Sara Khan/);
  assert.match(text, /Omar/);
  assert.match(text, /^Hello/);
  assert.equal(whatsappLinkWithGreeting({ phone: "abc" }, "Omar"), null);
});

test("S39-1 the greeting follows the customer's language, never the salesperson's interface", () => {
  assert.equal(leadGreetingLanguage({ customer_name: "سارة", landing_page: null }), "ar");
  assert.equal(leadGreetingLanguage({ customer_name: "Sara", landing_page: "https://newme.ae/ar/villas" }), "ar");
  assert.equal(leadGreetingLanguage({ customer_name: "刘伟", landing_page: null }), "en");
  assert.match(whatsappGreeting({ customer_name: "سارة" }, "Omar"), /^مرحباً سارة/);
  assert.match(whatsappGreeting({ customer_name: "+971501234567" }, "Omar"), /^Hello,/, "a phone number is not a name");
});

test("S39-1 quick log: one tap sends a method and an optional note, nothing else is required", () => {
  assert.deepEqual(quickLogBody("whatsapp", "  asked for a visit  "), { contact_method: "whatsapp", summary: "asked for a visit" });
  assert.deepEqual(quickLogBody("phone", ""), { contact_method: "phone" });
  assert.deepEqual(quickLogBody("telepathy", null), { contact_method: "other" });
});

test("S39-1 the lead page renders the action bar for owners and managers; the bar logs through the contacts route", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.ok(page.includes("<LeadActionBar"));
  assert.ok(page.includes('lead.assigned_to === currentUserId'));
  const bar = read("src/app/(dashboard)/leads/[id]/LeadActionBar.tsx");
  for (const token of ['data-testid="action-call"', 'data-testid="action-whatsapp"', 'data-testid="action-quick-log"', "/contacts", "quickLogBody", "telHref", "whatsappLinkWithGreeting"]) {
    assert.ok(bar.includes(token), token);
  }
});

function fakeLeadDb({ lead, milestones = [], updateError = null, milestoneError = null, rpcError = null }) {
  const state = { lead: { ...lead }, milestones: [...milestones], rpc: [], updates: [] };
  const from = (table) => {
    const q = { filters: {} };
    const api = {
      select() { return api; },
      eq(k, v) { q.filters[k] = v; return api; },
      update(patch) { q.patch = patch; return api; },
      insert(row) { q.row = row; return api; },
      async single() { return { data: { ...state.lead }, error: null }; },
      async maybeSingle() { return { data: state.milestones.find((m) => m.milestone_key === q.filters.milestone_key) ?? null, error: null }; },
      then(resolve) {
        let result = { data: null, error: null };
        if (q.patch && table === "leads") { if (updateError) result = { data: null, error: updateError }; else { Object.assign(state.lead, q.patch); state.updates.push(q.patch); } }
        if (q.row && table === "lead_milestones") { if (milestoneError) result = { data: null, error: milestoneError }; else state.milestones.push(q.row); }
        return Promise.resolve(result).then(resolve);
      },
    };
    return api;
  };
  const rpc = async (name, args) => {
    state.rpc.push([name, args]);
    if (rpcError) return { data: null, error: { message: rpcError } };
    state.lead.stage = args.p_next_stage;
    return { data: { stage: args.p_next_stage }, error: null };
  };
  return { state, from, rpc };
}

test("S39-2 a logged contact on a new lead completes first contact and moves it to contacted, filling the follow-up defaults", async () => {
  const db = fakeLeadDb({ lead: { stage: "new", final_status: null, quality: null, next_action: null, next_followup_date: null } });
  const result = await completeFirstContactAfterLog(db, { leadId: "l1", userId: "u1", now: new Date("2026-11-23T10:00:00Z") });
  assert.deepEqual(result, { advanced: true, stage: "contacted", reason: null, milestone: true });
  assert.deepEqual(db.state.updates, [{ next_action: "call", next_followup_date: "2026-11-24" }]);
  assert.equal(db.state.milestones[0].milestone_key, "first_contact");
  assert.deepEqual(db.state.rpc.map(([n, a]) => [n, a.p_expected_stage, a.p_next_stage]), [["transition_lead_stage", "new", "contacted"]]);
});

test("S39-2 a lead that is not new, or already closed, is left alone; a refused move never throws", async () => {
  const later = fakeLeadDb({ lead: { stage: "quotation_submitted", final_status: null } });
  assert.equal((await completeFirstContactAfterLog(later, { leadId: "l", userId: "u" })).advanced, false);
  assert.deepEqual(later.state.rpc, []);
  const refused = fakeLeadDb({ lead: { stage: "new", final_status: null, next_action: "call", next_followup_date: "2026-11-30" }, rpcError: "Forbidden: invalid CRM role" });
  const result = await completeFirstContactAfterLog(refused, { leadId: "l", userId: "u" });
  assert.equal(result.advanced, false);
  assert.equal(result.reason, "not_permitted");
});

test("S39-2 the contacts route needs neither a result nor a time, and runs the first-contact step after the record", () => {
  const route = read("src/app/api/leads/[id]/contacts/route.ts");
  assert.ok(route.includes('|| "Contacted"'));
  assert.ok(route.includes("completeFirstContactAfterLog"));
  assert.equal(route.includes("contact_result is required"), false);
});

// ── 3: stage rules ────────────────────────────────────────────────────────────────────────────────────────────────
test("S39-3 first contact needs one contact record and no quality rating; skipping forward is planned as one move", () => {
  const base = { stage: "new", finalStatus: null, milestoneKey: "quotation", quality: null, hasCompleteContact: true, nextAction: "call", nextFollowupDate: "2026-11-30" };
  assert.deepEqual(planStageStep(base), { next: "quotation_submitted" });
  assert.deepEqual(planStageStep({ ...base, hasCompleteContact: false }), { next: null, reason: "first_contact_gate" });
  assert.deepEqual(planStageStep({ ...base, stage: "quotation_submitted" }), { next: null, reason: null }, "never backwards");
  assert.deepEqual(planStageStep({ ...base, stage: "won", finalStatus: "won" }), { next: null, reason: null });
  assert.equal(evaluateFirstContactGate({ currentStage: "new", nextStage: "contacted", contactCount: 1, quality: null }).allowed, true);
  assert.equal(evaluateFirstContactGate({ currentStage: "new", nextStage: "contacted", contactCount: 0, quality: "good" }).allowed, false);
});

test("S39-3 milestones may skip forward but not go back; the first one is still first contact", () => {
  assert.equal(canCompleteMilestone(["first_contact"], "quotation").allowed, true);
  assert.equal(canCompleteMilestone(["first_contact", "solution"], "requirements").allowed, false);
  assert.equal(canCompleteMilestone([], "quotation").allowed, false);
});

test("S39-3 notes are optional on milestones and funnel stages; won still needs its amount, lost its reason (S41: won's note is optional too)", () => {
  const milestone = read("src/app/api/leads/[id]/milestone/route.ts");
  assert.ok(milestone.includes("|| `Milestone completed: ${milestoneKey}`"));
  assert.equal(milestone.includes("Milestone note is required"), false);
  assert.equal(milestone.includes("isAssessedQuality"), false);
  const stage = read("src/app/api/leads/[id]/stage/route.ts");
  assert.ok(stage.includes('if (!note && stage === "lost")')); // S41 (F02/N2): the amount tells Won's story, only Lost needs its reason
  assert.ok(stage.includes("ensureWonAmount"), "won still needs an amount");
});

test("S39-3 the migration is one re-runnable file that changes exactly the seven routines and nothing else", () => {
  const sql = read("supabase/migrations/20261123100000_s39_stage_rules_relaxed.sql");
  assert.ok(sql.startsWith("-- NO_ROLLBACK:"));
  const replaced = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/gi)].map((m) => m[1].toLowerCase()).sort();
  assert.deepEqual(replaced, ["check_milestone_order", "recomplete_lead_milestone", "sync_advance_lead_stage_from_sheet", "transition_lead_stage", "trg_check_first_contact_gate", "trg_check_stage_sequence", "trg_enforce_first_contact_milestone"]);
  assert.equal(/\b(create|alter|drop)\s+(table|policy|trigger|index)\b/i.test(sql.replace(/--.*$/gm, "")), false, "no table, policy, trigger or index change");
  const manifest = JSON.parse(read("infra/release/release-manifest.json"));
  assert.ok(manifest.deferred_contract.some((e) => e.file === "20261123100000_s39_stage_rules_relaxed.sql"));
  assert.ok(read("tests/database/s39-stage-rules.sql").includes("S39 ASSERT_OK"));
});

// ── 2: compact list ───────────────────────────────────────────────────────────────────────────────────────────────
const NOW = new Date("2026-11-23T10:00:00Z");
const L = (id, o = {}) => ({ id, stage: "contacted", final_status: null, last_contact_date: "2026-11-20", next_followup_date: "2026-12-30", created_at: "2026-11-01T00:00:00Z", ...o });

test("S39-2 default sort is uncontacted, then overdue (most overdue first), then newest", () => {
  const rows = [
    L("recent-ok", { created_at: "2026-11-22T00:00:00Z" }),
    L("overdue-new", { next_followup_date: "2026-11-22" }),
    L("overdue-old", { next_followup_date: "2026-11-10" }),
    L("fresh-old", { stage: "new", last_contact_date: null, created_at: "2026-11-05T00:00:00Z" }),
    L("fresh-new", { stage: "new", last_contact_date: null, created_at: "2026-11-23T05:00:00Z" }),
    L("older-ok", { created_at: "2026-10-01T00:00:00Z" }),
    L("closed", { final_status: "won", stage: "won", next_followup_date: "2026-01-01", last_contact_date: null }),
  ];
  assert.deepEqual(sortLeads(rows, DEFAULT_LEAD_SORT, NOW).map((r) => r.id),
    ["fresh-new", "fresh-old", "overdue-old", "overdue-new", "recent-ok", "closed", "older-ok"]);
  assert.deepEqual(sortLeads(rows, "newest", NOW).map((r) => r.id)[0], "fresh-new");
  assert.equal(rows[0].id, "recent-ok", "the input is not reordered");
});

test("S39-2 the chosen sort is remembered, an unknown stored value falls back; the list pages instead of rendering everything", () => {
  assert.equal(parseLeadSort("newest"), "newest");
  assert.equal(parseLeadSort("garbage"), DEFAULT_LEAD_SORT);
  assert.equal(parseLeadSort(null), DEFAULT_LEAD_SORT);
  const rows = Array.from({ length: 128 }, (_, i) => L(`l${i}`));
  assert.equal(pageOf(rows, 1).length, MOBILE_PAGE_SIZE);
  assert.equal(pageOf(rows, 2).length, MOBILE_PAGE_SIZE * 2);
  assert.equal(pageOf(rows, 99).length, 128);
  const list = read("src/app/(dashboard)/leads/_components/LeadsMobileList.tsx");
  assert.ok(list.includes("localStorage.setItem(LEAD_SORT_STORAGE_KEY"));
  assert.ok(list.includes("pageOf(sorted, pages)"));
  const page = read("src/app/(dashboard)/leads/page.tsx");
  assert.ok(page.includes("narrow ? ("), "phones get the list, wide screens keep the board");
  assert.ok(page.includes("<LeadsMobileList"));
});

// ── 4: workbench inbox ────────────────────────────────────────────────────────────────────────────────────────────
test("S39-4 the workbench inbox puts newly assigned, never-contacted leads on top whatever their old dates", () => {
  const overdue = Array.from({ length: 25 }, (_, i) => ({ id: `old${i}`, next_followup_date: `2026-10-${String(i + 1).padStart(2, "0")}` }));
  const out = mergeInbox({ new: [{ id: "fresh" }], due_today: [], overdue, later: [] }, INBOX_LIMIT);
  assert.equal(out[0].id, "fresh");
  assert.equal(out[0].inbox_group, "new");
  assert.equal(out.length, INBOX_LIMIT);
  assert.ok(read("src/app/api/workbench/route.ts").includes('q.eq("stage", "new").is("last_contact_date", null)'));
});

// ── 5: one phone reader ───────────────────────────────────────────────────────────────────────────────────────────
const UAE_SPELLINGS = ["0501234567", "050 123 4567", "050-123-4567", "501234567", "971501234567", "+971501234567", "+971 50 123 4567", "00971501234567", "00 971 (50) 123-4567", "+971 050 123 4567"];

test("S39-5 every UAE spelling is the same customer in every entry point", () => {
  for (const spelling of UAE_SPELLINGS) {
    assert.equal(intakePhone(spelling), "+971501234567", spelling);
    assert.equal(phoneIdentityKey(spelling), "971501234567", spelling);
    assert.equal(normalizeWhatsAppPhoneKey(spelling), "971501234567", `whatsapp ${spelling}`);
    assert.equal(sheetPhone(spelling)?.e164, "+971501234567", `sheet ${spelling}`);
    const row = mapMetaLeadToRow({ id: "1234567890123456", field_data: [{ name: "phone_number", values: [spelling] }] });
    assert.equal(row.phone, "+971501234567", `meta form ${spelling}`);
    assert.equal(normalizePhone(spelling).e164, "+971501234567", `manual create ${spelling}`);
  }
});

test("S39-5 other countries keep E.164; odd numbers are not dropped by an automatic intake; the WhatsApp key still equals the database key", () => {
  assert.equal(intakePhone("+44 7911 123456"), "+447911123456");
  assert.equal(intakePhone("0044 7911 123456"), "+447911123456");
  assert.equal(intakePhone("12345"), null);
  assert.equal(intakePhone("abc"), null);
  assert.equal(intakePhone(null), null);
  for (const raw of [...UAE_SPELLINGS, "+44 7911 123456", "042345678", "+97142345678", "12345678"]) {
    // the SQL function public.wa_phone_key() applies exactly this rule (see 20261118200000_whatsapp_ctwa_leads.sql)
    let d = raw.replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("9710") && d.length === 13) d = `971${d.slice(4)}`;
    else if (d.startsWith("0") && d.length >= 9 && d.length <= 10) d = `971${d.slice(1)}`;
    else if (d.length === 9 && d.startsWith("5")) d = `971${d}`;
    assert.equal(normalizeWhatsAppPhoneKey(raw), d.length >= 7 && d.length <= 15 ? d : null, raw);
  }
});

test("S39-5 the website form stores the same E.164 as every other door", () => {
  const ts = require("typescript");
  const source = read("src/lib/public-lead.ts");
  assert.ok(source.includes('from "./lead-contact.mjs"'));
  assert.ok(source.includes("normalizeLeadPhone(value)"));
  assert.ok(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText.length > 0);
});

function metaDb(rows) {
  const store = rows.map((r) => ({ archived: false, meta_leadgen_id: null, ...r }));
  const builder = (table) => {
    const filters = []; let op = "select"; let payload;
    const api = {
      select() { return api; }, insert(p) { op = "insert"; payload = p; return api; }, update(p) { op = "update"; payload = p; return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; }, is(k, v) { filters.push((r) => (r[k] ?? null) === v); return api; },
      ilike(k, pattern) {
        const re = new RegExp(`^${String(pattern).split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
        filters.push((r) => re.test(String(r[k] ?? ""))); return api;
      },
      order() { return api; }, limit() { return api; },
      run() {
        if (op === "insert") { const row = { id: `new-${store.length}`, archived: false, ...payload }; store.push(row); return { data: [row], error: null }; }
        if (op === "select" && filters.length === 0) return { data: [], error: null };
        const hit = store.filter((r) => filters.every((f) => f(r)));
        if (op === "update") hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      },
      single() { const r = api.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      maybeSingle() { const r = api.run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then(res, rej) { return Promise.resolve(api.run()).then(res, rej); },
    };
    return api;
  };
  return { store, from: (table) => (table === "leads" ? builder(table) : { select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) };
}

test("S39-5 a Meta form lead merges into the same customer stored in another spelling (no duplicate lead)", async () => {
  const db = metaDb([{ id: "old", phone: "050 123 4567", created_at: "2026-10-01" }, { id: "other", phone: "050 999 4568", created_at: "2026-10-02" }]);
  const row = mapMetaLeadToRow({ id: "1234567890123456", field_data: [{ name: "phone_number", values: ["+971 50 123 4567"] }], ad_id: "123456789", form_id: "998877665544" });
  const result = await storeMetaLead(db, row);
  assert.equal(result.outcome, "merged");
  assert.equal(result.id, "old");
  assert.equal(db.store.length, 2, "no new row");
});

const metaRow = (phone, email) => mapMetaLeadToRow({ id: "1234567890123456", field_data: [{ name: "phone_number", values: [phone] }, ...(email ? [{ name: "email", values: [email] }] : [])], ad_id: "123456789", form_id: "998877665544" });

test("S39-5 a stored spelling with separators inside the last digits is still found", async () => {
  const db = metaDb([{ id: "old", phone: "+971 50 123 45 67", created_at: "2026-10-01" }]);
  assert.equal((await storeMetaLead(db, metaRow("0501234567"))).outcome, "merged");
});

test("S39-5 a closed (won or lost) or archived lead is never reopened by a phone or email match; a new lead is made", async () => {
  for (const closed of [{ final_status: "won" }, { final_status: "lost" }, { archived: true }]) {
    const db = metaDb([{ id: "old", phone: "050 123 4567", email: "a@x.com", created_at: "2026-10-01", ...closed }]);
    assert.equal((await storeMetaLead(db, metaRow("0501234567", "a@x.com"))).outcome, "inserted", JSON.stringify(closed));
    assert.equal(db.store.length, 2);
  }
});

test("S39-5 two different emails on the same phone are two people: no merge; one side without email still merges", async () => {
  const two = metaDb([{ id: "old", phone: "050 123 4567", email: "a@x.com", created_at: "2026-10-01" }]);
  assert.equal((await storeMetaLead(two, metaRow("0501234567", "b@x.com"))).outcome, "inserted");
  const same = metaDb([{ id: "old", phone: "050 123 4567", email: "A@x.com", created_at: "2026-10-01" }]);
  assert.equal((await storeMetaLead(same, metaRow("0501234567", "a@x.com"))).outcome, "merged");
  const noMail = metaDb([{ id: "old", phone: "050 123 4567", email: null, created_at: "2026-10-01" }]);
  assert.equal((await storeMetaLead(noMail, metaRow("0501234567", "a@x.com"))).outcome, "merged");
});

test("S39-5 a junk number (one repeated digit or a simple run) never builds a merge key", async () => {
  for (const junk of ["0500000000", "+971 55 555 5555", "1234567", "9876543210"]) {
    assert.equal(phoneIdentityKey(junk), null, junk);
  }
  assert.equal(phoneIdentityKey("050 123 4567"), "971501234567");
  const db = metaDb([{ id: "old", phone: "050 000 0000", created_at: "2026-10-01" }]);
  assert.equal((await storeMetaLead(db, metaRow("0500000000"))).outcome, "inserted");
});

test("S39-5 the application phone key equals the database key for 9710-prefixed landlines too", () => {
  const db = (raw) => { // public.wa_phone_key(), step by step
    let d = raw.replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("9710") && d.length === 13) d = `971${d.slice(4)}`;
    else if (d.startsWith("0") && d.length >= 9 && d.length <= 10) d = `971${d.slice(1)}`;
    else if (d.length === 9 && d.startsWith("5")) d = `971${d}`;
    return d.length >= 7 && d.length <= 15 ? d : null;
  };
  for (const raw of ["+971 04 234 5678", "0097104 2345678", "04 234 5678", "+971 4 234 5678", "+971 050 123 4567"]) {
    assert.equal(normalizeWhatsAppPhoneKey(raw), db(raw), raw);
  }
});

// ── Meta funnel on a skipped stage ────────────────────────────────────────────────────────────────────────────────
test("S39-3 a skip reports every funnel step passed, in order", () => {
  assert.deepEqual(funnelStagesBetween("new", "quotation_submitted"), ["contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted"]);
  assert.deepEqual(funnelStagesBetween("contacted", "solution_submitted"), ["requirement_confirmed", "solution_submitted"]);
  assert.deepEqual(funnelStagesBetween("new", "contacted"), ["contacted"]);
  assert.deepEqual(funnelStagesBetween("quotation_submitted", "won"), ["won"]);
  assert.deepEqual(funnelStagesBetween("negotiation", "quotation_submitted"), ["quotation_submitted"]);
});

test("S39-3 new -> quotation_submitted queues Contacted, Qualified, Solution Submitted and Quoted; the stage route and both milestone callers use it", async () => {
  const rows = [];
  const db = { from: () => ({ upsert: async (r) => { rows.push(r.event_name); return { error: null }; },
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { meta_leadgen_id: "1234567890123456" }, error: null }) }) }) }) };
  await enqueueMetaCrmFunnelBetween(db, { id: "l1", meta_leadgen_id: "1234567890123456" }, "new", "quotation_submitted");
  assert.deepEqual(rows, ["Contacted", "Qualified", "Solution Submitted", "Quoted"]);
  assert.ok(read("src/app/api/leads/[id]/stage/route.ts").includes("enqueueMetaCrmFunnelBetween(supabaseAdmin"));
  assert.ok(read("src/app/api/leads/[id]/milestone/route.ts").includes("enqueueMetaCrmFunnelForLead(supabaseAdmin, leadId, current.stage, result.stage)"));
  assert.ok(read("src/app/api/quotations/generate/route.ts").includes("enqueueMetaCrmFunnelForLead(supabaseAdmin, lead_id, current.stage"));
});

// ── 6: WhatsApp ad badge and waiting state ────────────────────────────────────────────────────────────────────────
test("S39-6 a click merged into an older lead is an ad lead and shows the waiting state until someone answers", () => {
  const merged = { source: "fb", source_channel: "meta_lead_form", ctwa_clid: "AbC123xyz-123", stage: "contacted", last_contact_date: "2026-11-01",
    wa_first_inbound_at: "2026-11-22T09:00:00Z", wa_first_reply_at: null, final_status: null };
  assert.equal(isWhatsAppAdLead(merged), true);
  assert.equal(isWaitingForReply(merged), true, "an old lead whose last contact is before the click is waiting");
  assert.equal(isWaitingForReply({ ...merged, last_contact_date: "2026-11-22" }), false, "contact logged on the click day counts as the answer");
  assert.equal(isWaitingForReply({ ...merged, wa_first_reply_at: "2026-11-22T09:05:00Z" }), false);
  assert.equal(isWaitingForReply({ ...merged, final_status: "won" }), false);
  assert.equal(isWaitingForReply({ ...merged, ctwa_clid: null }), false, "not an ad lead");
});

test("S39-6 the badge and waiting state appear in the board card, the compact list and the lead header; the list data carries the fields", () => {
  for (const file of ["src/app/(dashboard)/leads/_components/LeadCard.tsx", "src/app/(dashboard)/leads/_components/LeadsMobileList.tsx"]) {
    const source = read(file);
    assert.ok(source.includes("isWhatsAppAdLead") && source.includes("isWaitingForReply"), file);
    assert.ok(source.includes('t("s37.wa.badge")'), file);
  }
  const route = read("src/app/api/leads/list/route.ts");
  for (const column of ["wa_first_inbound_at", "wa_first_reply_at", "ctwa_clid"]) assert.ok(route.includes(column), column);
  assert.ok(read("src/app/(dashboard)/leads/[id]/page.tsx").includes("isWaitingForReply(lead)"));
});

test("S39-1 the quick-log button shows for every role the server allows (any assigned user; admin, boss and operator on every lead)", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.ok(page.includes('canLog={["admin", "boss", "operator"].includes(salesRole ?? "") || (!!currentUserId && lead.assigned_to === currentUserId)}'));
  assert.ok(!page.includes('salesRole === "sales" && lead.assigned_to === currentUserId)}\n          onLogged'));
});

test("S39-2 the compact list keeps its page when the parent refreshes with a new array of the same leads", () => {
  const list = read("src/app/(dashboard)/leads/_components/LeadsMobileList.tsx");
  assert.ok(list.includes("pageState.resetKey === resetKey && pageState.sort === sort"));
  assert.ok(!list.includes("pageState.list === leads"), "the array identity must not drive the reset");
  assert.ok(read("src/app/(dashboard)/leads/page.tsx").includes("resetKey={JSON.stringify([search, stageFilter"));
});
