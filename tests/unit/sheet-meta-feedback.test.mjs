// Sheet quality/quote outcome -> Meta feedback. Synthetic data only: no real ids, names, phones or amounts of customers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyPlan, buildLeadIndex, classifyRow, matchLead, parseRegister, planFeedback, FORM_EVENT } from "../../src/lib/sheet-meta-feedback.mjs";
import { parseArgs, runFeedback } from "../../scripts/sheet-meta-feedback.mjs";
import { leadRef } from "../../src/lib/meta-ids-export.mjs";

const NOW = Date.parse("2030-03-10T08:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
const CLID = "AfSyntheticClickId_0000000000000000000000000001";
const L = {
  form: { id: "11111111-1111-4111-8111-111111111111", meta_leadgen_id: "900000000000001", ctwa_clid: null, created_at: daysAgo(2), archived: false, quotation_value: null },
  wa: { id: "22222222-2222-4222-8222-222222222222", meta_leadgen_id: null, ctwa_clid: CLID, created_at: daysAgo(3), archived: false, quotation_value: null },
  old: { id: "33333333-3333-4333-8333-333333333333", meta_leadgen_id: "900000000000003", ctwa_clid: null, created_at: daysAgo(60), archived: false, quotation_value: null },
  arch: { id: "44444444-4444-4444-8444-444444444444", meta_leadgen_id: "900000000000004", ctwa_clid: null, created_at: daysAgo(1), archived: true, quotation_value: null },
  form2: { id: "55555555-5555-4555-8555-555555555555", meta_leadgen_id: "900000000000005", ctwa_clid: null, created_at: daysAgo(1), archived: false, quotation_value: 5000 },
  waNoWaba: { id: "66666666-6666-4666-8666-666666666666", meta_leadgen_id: null, ctwa_clid: "AfSyntheticClickId_0000000000000000000000000002", created_at: daysAgo(1), archived: false, quotation_value: null },
};
const index = buildLeadIndex(Object.values(L));
const HEADER = ["Master Lead ID", "Lead quality", "Opportunity stage", "Quote value AED", "Source lead ID"];
const sheet = (...rows) => [HEADER, ...rows];
const empty = () => ({ existing: { form: new Set(), wa: new Set(), waQuote: new Set() }, waba: new Set([L.wa.id]), nowMs: NOW });

test("header is found by name; rows without ids are dropped; a missing column is an error", () => {
  const rows = parseRegister([["x", ...HEADER], ["", "", "", "", "", ""], ["", "WA-NM-aaaaaaaaaaaa", "Qualified", "", "1,200", ""]]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quality, "qualified"); assert.equal(rows[0].quoteRaw, "1,200");
  assert.throws(() => parseRegister([["Master Lead ID", "Lead quality"]]), /lacks/);
});

test("classification: qualified, not fit, strict quote amounts", () => {
  const c = (quality, quoteRaw = "") => classifyRow({ quality, quoteRaw });
  assert.equal(c("qualified").outcome, "qualified");
  assert.equal(c("not fit").outcome, "not_fit");
  assert.equal(c("not assessed").outcome, "none");
  assert.equal(c("not assessed", "AED 12,500").quote, 12500);
  assert.equal(c("qualified", "12k").quote, null);
  assert.equal(c("qualified", "12k").badQuote, true);
  assert.equal(c("qualified", "0").quote, null);
  assert.equal(c("qualified", "0").badQuote, false);
});

test("matching: lead ref, lead uuid, META id, multi-line source ids; unknown ids do not match", () => {
  const m = (master, source = "") => matchLead({ master, source }, index)?.id ?? null;
  assert.equal(m(`WA-${leadRef(L.wa.id)}`), L.wa.id);
  assert.equal(m(`WA-${L.wa.id}`), L.wa.id);
  assert.equal(m("META-900000000000001"), L.form.id);
  assert.equal(m("X-1", "l:900000000000001"), L.form.id);
  assert.equal(m("X-1", `l:123\nctwa:${CLID}`), L.wa.id);
  assert.equal(m("META-900000000000999"), null);
  assert.equal(m("LEGACY-1", "file.xls"), null);
});

test("plan: qualified form lead queues Qualified, a quote adds Quoted (same names as the OS stage mapping)", () => {
  const rows = parseRegister(sheet(["META-900000000000001", "Qualified", "", "", ""], ["META-900000000000005", "Not assessed", "", "8000", ""]));
  const plan = planFeedback(rows, index, empty());
  assert.equal(FORM_EVENT.qualified, "Qualified"); assert.equal(FORM_EVENT.quoted, "Quoted"); assert.equal(FORM_EVENT.lost, "Lost");
  assert.deepEqual(plan.items.map((i) => i.events.map((e) => e.kind)), [["form_qualified"], ["form_qualified", "form_quoted"]]);
  assert.equal(plan.counts.form_quoted_os_value_known, 1);
  assert.equal(plan.total, 3);
});

test("plan: click-to-WhatsApp lead needs a business account; quote is valued; Not fit sends nothing", () => {
  const rows = parseRegister(sheet(
    [`WA-${L.wa.id}`, "Qualified", "", "15000", ""], [`WA-${L.waNoWaba.id}`, "Qualified", "", "", ""],
  ));
  const plan = planFeedback(rows, index, empty());
  assert.deepEqual(plan.items[0].events.map((e) => e.kind), ["wa_qualified", "wa_quote_valued"]);
  assert.equal(plan.items[0].events[1].value, 15000);
  assert.equal(plan.counts.wa_no_waba, 1);
  const bare = planFeedback(parseRegister(sheet(["META-900000000000042", "Qualified", "", "", ""])), buildLeadIndex([{ ...L.form, meta_leadgen_id: null, ctwa_clid: null }]), empty());
  assert.equal(bare.counts.unmatched, 1);
  const noClid = planFeedback(parseRegister(sheet([`WA-${L.form.id}`, "Qualified", "", "", ""])), buildLeadIndex([{ ...L.form, meta_leadgen_id: null, ctwa_clid: null }]), empty());
  assert.equal(noClid.counts.no_ctwa_clid_or_leadgen, 1);
  const nf = planFeedback(parseRegister(sheet([`WA-${L.wa.id}`, "Not fit", "", "", ""])), index, empty());
  assert.equal(nf.total, 0); assert.equal(nf.counts.not_fit_wa_no_signal, 1);
});

test("plan: Not fit form lead sends Lost only when never qualified; switch can turn Lost off", () => {
  const rows = parseRegister(sheet(["META-900000000000001", "Not fit", "", "", ""]));
  assert.equal(planFeedback(rows, index, empty()).counts.form_lost, 1);
  assert.equal(planFeedback(rows, index, { ...empty(), sendLost: false }).counts.lost_disabled, 1);
  const e = empty(); e.existing.form.add(`${L.form.id}|Qualified`);
  assert.equal(planFeedback(rows, index, e).total, 0);
});

test("plan: idempotent against the queue, old and archived leads, duplicates, unknown ids", () => {
  const rows = parseRegister(sheet(
    ["META-900000000000001", "Qualified", "", "", ""], ["META-900000000000001", "Qualified", "", "", ""],
    ["META-900000000000003", "Qualified", "", "", ""], ["META-900000000000004", "Qualified", "", "", ""], ["META-900000000000777", "Qualified", "", "", ""],
  ));
  const e = empty(); e.existing.form.add(`${L.form.id}|Qualified`);
  const plan = planFeedback(rows, index, e);
  assert.equal(plan.total, 0);
  assert.equal(plan.counts.already_queued, 1); assert.equal(plan.counts.duplicate_rows, 1);
  assert.equal(plan.counts.too_old, 1); assert.equal(plan.counts.archived, 1); assert.equal(plan.counts.unmatched, 1);
});

test("plan: bounded per run, whole leads deferred in sheet order", () => {
  const rows = parseRegister(sheet(["META-900000000000001", "Qualified", "", "", ""], ["META-900000000000005", "Qualified", "", "9000", ""]));
  const plan = planFeedback(rows, index, { ...empty(), maxEvents: 2 });
  assert.equal(plan.items.length, 1); assert.equal(plan.counts.deferred_by_cap, 1);
});

/** Tiny table fake: records upserts/inserts, answers selects from fixed rows. */
function fakeDb(tables) {
  const calls = [];
  const from = (name) => {
    const q = { filters: [], ops: null };
    const chain = new Proxy({}, { get(_, prop) {
      if (prop === "then") return (res) => res({ data: (tables[name] ?? []).filter((r) => q.filters.every((f) => f(r))), error: null });
      if (prop === "upsert" || prop === "insert") return (row, opts) => { calls.push({ table: name, op: prop, row, opts }); return Object.assign(Promise.resolve({ error: null }), { select: () => ({ maybeSingle: async () => ({ data: { id: row.id }, error: null }) }) }); };
      if (prop === "maybeSingle") return async () => ({ data: (tables[name] ?? []).filter((r) => q.filters.every((f) => f(r)))[0] ?? null, error: null });
      if (prop === "eq") return (c, v) => { q.filters.push((r) => r[c] === v); return chain; };
      if (prop === "in") return (c, vs) => { q.filters.push((r) => vs.includes(r[c])); return chain; };
      return () => chain; // select, order, range, limit, gte ...
    } });
    return chain;
  };
  return { from, calls };
}

test("apply: uses the existing queues and dedupe keys, WhatsApp quote carries the sheet amount in AED", async () => {
  const db = fakeDb({ leads: [{ id: L.wa.id, ctwa_clid: CLID, phone: null }], whatsapp_conversations: [{ lead_id: L.wa.id, first_ctwa_clid: CLID, waba_id: "987654321" }] });
  const plan = planFeedback(parseRegister(sheet(["META-900000000000001", "Qualified", "", "7000", ""], [`WA-${L.wa.id}`, "Qualified", "", "15000", ""])), index, empty());
  const res = await applyPlan(db, plan.items, { nowSeconds: 1_900_000_000 });
  assert.deepEqual(res, { queued: 4, skipped: 0 });
  const form = db.calls.filter((c) => c.table === "meta_crm_stage_events");
  assert.deepEqual(form.map((c) => c.row.event_name), ["Qualified", "Quoted"]);
  assert.deepEqual(form.map((c) => c.row.event_time), [1_899_999_999, 1_900_000_000]);
  assert.ok(form.every((c) => c.opts.onConflict === "lead_id,crm_stage" && c.opts.ignoreDuplicates === true));
  const wa = db.calls.find((c) => c.table === "whatsapp_capi_events");
  assert.equal(wa.row.event_name, "QualifiedLead"); assert.equal(wa.opts.onConflict, "lead_id,event_name");
  const outbox = db.calls.find((c) => c.table === "business_events");
  const ev = outbox.row.event_data.payload.data[0];
  assert.equal(ev.event_name, "InitiateCheckout"); assert.deepEqual(ev.custom_data, { currency: "AED", value: 15000 });
  assert.equal(ev.event_id, `wa-quote:${L.wa.id}`);
});

test("run: dry run by default and execute is refused while the switch is off; nothing is written", async () => {
  const leads = Object.values(L);
  const db = fakeDb({ leads, meta_crm_stage_events: [], whatsapp_capi_events: [], business_events: [], whatsapp_conversations: [] });
  const sheetValues = sheet(["META-900000000000001", "Qualified", "", "", ""]);
  const args = parseArgs([], {});
  assert.equal(args.execute, false);
  const dry = await runFeedback({ db, sheetValues, args, env: {}, nowMs: NOW });
  assert.equal(dry.mode, "dry_run"); assert.equal(dry.would_enqueue_total, 1);
  const blocked = await runFeedback({ db, sheetValues, args: parseArgs(["--execute"], {}), env: {}, nowMs: NOW });
  assert.equal(blocked.mode, "dry_run"); assert.match(blocked.execute_blocked, /SHEET_META_FEEDBACK_ENABLED/);
  assert.equal(db.calls.length, 0);
  const on = await runFeedback({ db, sheetValues, args: parseArgs(["--execute"], {}), env: { SHEET_META_FEEDBACK_ENABLED: "true" }, nowMs: NOW });
  assert.equal(on.mode, "execute"); assert.deepEqual(on.applied, { queued: 1, skipped: 0 });
  assert.deepEqual(Object.keys(on).filter((k) => /^(lead_id|leads|phone|name|ctwa_clid)$/i.test(k)), []);
});

test("the job never writes the sheet or OS lead fields and the unit template ships off", () => {
  for (const f of ["scripts/sheet-meta-feedback.mjs", "src/lib/sheet-meta-feedback.mjs"]) {
    const t = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(t, /values\.update|values:append|batchUpdate|\.from\("leads"\)\.(update|insert|upsert|delete)/, f);
  }
  const env = readFileSync(new URL("../../infra/sheet-meta-feedback/sheet-meta-feedback.env.example", import.meta.url), "utf8");
  assert.match(env, /^SHEET_META_FEEDBACK_ENABLED=false$/m);
  assert.match(readFileSync(new URL("../../infra/sheet-meta-feedback/newme-sheet-meta-feedback.service", import.meta.url), "utf8"), /^# STATUS: after-flag/m);
});
