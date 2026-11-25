// S44: small follow-ups left open by earlier reviews. Synthetic data only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planBatches, runAll } from "../../scripts/run-node-tests.mjs";
import { isNoAnswer, summarizeFeedbackBacklog } from "../../src/lib/sales-feedback-brief.mjs";
import { buildLeadIndex, parseRegister, planFeedback, rowExclusion } from "../../src/lib/sheet-meta-feedback.mjs";
import { todayThreeThings } from "../../src/lib/workbench-today.mjs";
import { loadFeedbackBacklog } from "../../scripts/daily-brief.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

// ── 1. test runner always runs both batches ───────────────────────────────────────────────────────────────────────
test("S44-1 runner: a failing ordinary batch does not skip the Module._load tests; exit is non-zero with a per-batch summary", () => {
  const plan = planBatches(["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"], (f) => (f.endsWith("b.test.mjs") || f.endsWith("c.test.mjs") ? "Module._load = x" : "plain"));
  assert.deepEqual(plan.ordinary, [["tests/a.test.mjs"]]);
  assert.deepEqual(plan.loader, [["tests/b.test.mjs"], ["tests/c.test.mjs"]]);
  const ran = [];
  const logs = [];
  const result = runAll(plan, (files) => { ran.push(files[0]); return { status: files[0].endsWith("a.test.mjs") ? 1 : 0 }; }, (m) => logs.push(m));
  assert.deepEqual(ran, ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"], "every batch ran");
  assert.equal(result.exitCode, 1);
  assert.equal(result.failures.length, 1);
  assert.ok(logs.some((l) => l.includes("[ordinary]") && l.includes("exit 1")));
  const failTwo = runAll(plan, (files) => ({ status: files[0].endsWith("a.test.mjs") ? 0 : 2 }), () => {});
  assert.deepEqual(failTwo.failures.map((f) => f.name), ["loader", "loader"]);
  assert.equal(runAll(plan, () => ({ status: 0 }), () => {}).exitCode, 0);
  assert.equal(runAll(plan, (files) => (files[0].endsWith("c.test.mjs") ? { signal: "SIGKILL" } : { status: 0 }), () => {}).exitCode, 1);
});

// ── 2. sheet meta feedback skips test / held rows ─────────────────────────────────────────────────────────────────
const NOW = Date.parse("2030-03-10T08:00:00Z");
const LEAD = { id: "11111111-1111-4111-8111-111111111111", meta_leadgen_id: "900000000000001", ctwa_clid: null, created_at: new Date(NOW - 86_400_000).toISOString(), archived: false, quotation_value: null };
const REG_HEAD = ["Master Lead ID", "Lead quality", "Quote value AED", "Source lead ID", "Test record", "Dispatch status"];
const planFor = (...rows) => planFeedback(parseRegister([REG_HEAD, ...rows]), buildLeadIndex([LEAD]), { existing: { form: new Set(), wa: new Set(), waQuote: new Set() }, waba: new Set(), nowMs: NOW });

test("S44-2 sheet feedback: test records, excluded-test rows and rows held or closed as duplicates never queue Meta events", () => {
  assert.equal(planFor(["META-900000000000001", "Qualified", "", "", "", ""]).items.length, 1, "a normal row still queues");
  for (const [test, dispatch, key] of [["Yes", "", "test_rows"], ["", "Excluded - test", "test_rows"], ["", "Duplicate review", "held_rows"], ["", "Duplicate - not dispatched", "held_rows"]]) {
    const plan = planFor(["META-900000000000001", "Qualified", "5000", "", test, dispatch]);
    assert.equal(plan.items.length, 0, `${test}/${dispatch}`);
    assert.equal(plan.counts[key], 1);
  }
  assert.equal(rowExclusion({ testRecord: "", dispatch: "delivered" }), null);
  // a register without these optional columns behaves as before
  const rows = parseRegister([["Master Lead ID", "Lead quality", "Quote value AED", "Source lead ID"], ["META-900000000000001", "Qualified", "", ""]]);
  assert.equal(rowExclusion(rows[0]), null);
});

// ── 3. sales feedback brief ───────────────────────────────────────────────────────────────────────────────────────
test("S44-3 sales feedback: a note with real contact is not a no-answer-only note, plain no-answer notes still are", () => {
  assert.equal(isNoAnswer("Was busy, confirmed interest and asked for a quote by Friday"), false);
  assert.equal(isNoAnswer("No answer"), true);
  assert.equal(isNoAnswer("12/11 no answer, tried twice"), true);
  assert.equal(isNoAnswer("Busy.\nNo answer again"), true);
  assert.equal(isNoAnswer("没接，关机"), true);
  assert.equal(isNoAnswer("Customer wants drawings"), false);
});

const NOW_FB = new Date("2026-11-23T08:00:00Z");
const regHead = ["Master Lead ID", "Assigned to", "Assigned at", "Test record"];
const regRow = ["NM-AAA", "Rana", "2026-11-18 09:00", ""];
const salesGrid = (laterHeader, later) => [["Lead key", "Day 1 feedback", "Day 2 feedback", laterHeader], ["NM-AAA", "No answer", "", later]];

test("S44-3 sales feedback: both supported 'Later follow-ups' headers are read, so later substantive notes clear the stale flag", () => {
  for (const header of ["Later follow-ups / previous records", "Later follow-ups / B2B notes", "Follow-up notes"]) {
    const clear = summarizeFeedbackBacklog([regHead, regRow], [salesGrid(header, "Called back, customer approved the quote and will pay deposit")], { now: NOW_FB });
    assert.equal(clear.staleTotal, 0, header);
    const stale = summarizeFeedbackBacklog([regHead, regRow], [salesGrid(header, "")], { now: NOW_FB });
    assert.equal(stale.staleTotal, 1, header);
  }
  const busyButContacted = summarizeFeedbackBacklog([regHead, regRow], [salesGrid("Later follow-ups / previous records", "Was busy, confirmed interest and asked for a quote by Friday")], { now: NOW_FB });
  assert.equal(busyButContacted.staleTotal, 0);
});

// ── 4. daily brief bounded sheet read ─────────────────────────────────────────────────────────────────────────────
test("S44-4 daily brief: a sheet read that never answers drops the optional section instead of holding the brief back", async () => {
  const started = Date.now();
  const result = await loadFeedbackBacklog({ now: NOW_FB, env: { NEWME_BRIEF_FEEDBACK_TIMEOUT_MS: "50" }, readGrids: () => new Promise(() => {}) });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2000);
  const ok = await loadFeedbackBacklog({ now: NOW_FB, env: {}, readGrids: async () => ({ registerGrid: [regHead, regRow], salesGrids: [salesGrid("Later follow-ups / B2B notes", "")] }) });
  assert.equal(ok.staleTotal, 1);
});

// ── 5. speed-to-lead ──────────────────────────────────────────────────────────────────────────────────────────────
const SNOW = new Date("2026-11-23T08:10:00Z");
const ago = (min) => new Date(SNOW.getTime() - min * 60_000).toISOString();
const lead = (o = {}) => ({ id: "11111111-2222-3333-4444-555555555555", customer_name: "Zed Sample", phone: "0507391846", source: "fb", source_channel: "meta_lead_form",
  created_at: ago(10), assigned_to: "u1", archived: false, stage: "new", property_type: "Villa", area: "Marina", ...o });
const profiles = [{ id: "u1", full_name: "Rana Sales", phone: "0529876543", is_active: true, role: "sales" }];
class Query {
  constructor(rows) { this.rows = rows; }
  select() { return this; } eq() { return this; } or() { return this; } gte() { return this; } gt() { return this; } order() { return this; } range() { return this; } limit() { return this; }
  in(column, values) { if (column === "status") this.rows = this.rows.filter((r) => values.includes(r.status)); return this; }
  then(res, rej) { return Promise.resolve({ data: this.rows, error: null, count: this.rows.length }).then(res, rej); }
}
const fakeDb = (t) => ({ from: (n) => new Query(t[n] ?? []) });
const ON = () => ({ NEWME_SPEED_TO_LEAD_ENABLED: "true", CUSTOMER_WA_ACCESS_TOKEN: "synthetic-token", NEWME_SPEED_STATE_DIR: mkdtempSync(`${tmpdir()}/s44-`) });

test("S44-5 speed-to-lead: a lead under duplicate review or decided as duplicate gets no acknowledgement and no alert", async () => {
  const { runSpeedToLead } = await import("../../scripts/speed-to-lead.mjs");
  const sent = [];
  const deps = { execute: true, now: SNOW, env: ON(), send: async (m) => { sent.push(m); return true; }, sendCustomer: async (m) => { sent.push(m); return { ok: true }; } };
  const blocked = (status) => ({ leads: [lead()], lead_dispatch_state: [{ lead_id: lead().id, status }], profiles });
  for (const status of ["duplicate_review", "duplicate_not_dispatched", "excluded_test"]) {
    const r = await runSpeedToLead(fakeDb(blocked(status)), deps);
    assert.equal(r.candidates, 0, status);
  }
  assert.deepEqual(sent, []);
  const ok = await runSpeedToLead(fakeDb(blocked("delivered")), deps);
  assert.equal(ok.candidates, 1, "an ordinary dispatch state still goes out");
});

test("S44-5 speed-to-lead: the in-flight marker is on disk before Meta is contacted, and an interrupted send is never repeated", async () => {
  const { runSpeedToLead } = await import("../../scripts/speed-to-lead.mjs");
  const env = ON();
  const ledgerFile = `${env.NEWME_SPEED_STATE_DIR}/ledger.json`;
  let seenInFlight = false;
  let graph = 0;
  const interrupted = async () => {
    graph += 1;
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    seenInFlight = Object.values(ledger).some((e) => e.inflight === true && !e.done);
    throw new Error("process died mid-send"); // the completion record is never written
  };
  const db = () => fakeDb({ leads: [lead()], lead_dispatch_state: [], profiles });
  await runSpeedToLead(db(), { execute: true, now: SNOW, env, send: async () => true, sendCustomer: interrupted });
  assert.equal(seenInFlight, true);
  await runSpeedToLead(db(), { execute: true, now: new Date(SNOW.getTime() + 300_000), env, send: async () => true, sendCustomer: interrupted });
  assert.equal(graph, 1, "the next timer run does not send the same acknowledgement again");
  // A definite refusal from Meta (nothing was sent) clears the marker, so the normal retry rule still applies.
  const env2 = ON();
  let refused = 0;
  const deps2 = (i) => ({ execute: true, now: new Date(SNOW.getTime() + i * 60_000), env: env2, send: async () => true, sendCustomer: async () => { refused += 1; return { ok: false, ambiguous: false }; } });
  for (let i = 0; i < 5; i += 1) await runSpeedToLead(db(), deps2(i));
  assert.equal(refused, 3, "retried up to the 3-try limit");
});

// ── 6. workbench: today's tasks are fetched independently ─────────────────────────────────────────────────────────
test("S44-6 workbench: with 20 older overdue tasks filling both lists, today's tasks are still counted from their own fetch", () => {
  const now = new Date("2026-11-24T07:00:00Z"); // Dubai 24 Nov 11:00
  const old = Array.from({ length: 20 }, (_, i) => ({ id: `old${i}`, title: "Old", due_at: `2026-11-${String(1 + (i % 9)).padStart(2, "0")}T06:00:00Z`, lead_id: null }));
  const todayTasks = [{ id: "t1", title: "Call", due_at: "2026-11-24T10:00:00Z", lead_id: null }, { id: "t2", title: "Visit", due_at: "2026-11-24T05:00:00Z", lead_id: null }];
  const three = todayThreeThings({ inbox: [], tasks: old, overdue: old, todayTasks }, now);
  assert.equal(three.dueToday.count, 2);
  assert.deepEqual(three.dueToday.items.map((x) => x.id).sort(), ["t1", "t2"]);
  assert.equal(todayThreeThings({ inbox: [], tasks: old, overdue: old }, now).dueToday.count, 0, "without the fetch the backlog hides today");
  const route = read("src/app/api/workbench/route.ts");
  assert.match(route, /todayTasksResult/);
  assert.match(route, /tasks_today:/);
  assert.match(route, /\.gte\("due_at", todayStartIso\)[\s\S]{0,80}\.lt\("due_at", tomorrowStartIso\)/);
  assert.match(read("src/app/(dashboard)/workbench/page.tsx"), /todayTasks: data\?\.tasks_today/);
});

// ── 7. quotes: deletion survives in the phone layout ─────────────────────────────────────────────────────────────
test("S44-7 quotes: the phone cards keep the delete action with the same permission rule as the desktop row", () => {
  const src = read("src/app/(dashboard)/quotes/quotes-client.tsx");
  const cards = src.slice(src.indexOf('data-testid="quotes-mobile-cards"'), src.indexOf("{/* Table Header */}"));
  assert.match(cards, /canDeleteQuote\(quote\)/);
  assert.match(cards, /data-testid="quote-mobile-delete"/);
  assert.match(cards, /handleDeleteQuote\(e, quote\)/);
  const rule = /const canDeleteQuote = \(quote: Quotation\) =>[\s\S]*?userRole === "admin" \|\| userRole === "boss" \|\| userRole === "operator"/;
  assert.match(src, rule, "admin and boss keep delete");
  assert.match(src.slice(src.indexOf("{/* Table Header */}")), /canDeleteQuote\(quote\)/, "desktop row uses the same rule");
});
