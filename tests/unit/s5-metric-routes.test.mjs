// S5: one definition per metric, Dubai-time bucketing, paged reads - checked
// across the real route handlers on one shared data set, with the host zone set
// to Asia/Shanghai (production) and a clock just before a Dubai month end.
//
// This file replaces the process-wide module loader, so scripts/run-node-tests.mjs
// runs it in its own process.
process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/* ───────── a PostgREST-like in-memory client (1000-row response cap) ───────── */
const MAX_ROWS = 1000;
const asTime = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : null);
function compare(a, b) {
  const ta = asTime(a), tb = asTime(b);
  if (ta !== null && tb !== null) return ta - tb;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
const col = (row, name) => (name.includes(".") ? undefined : row[name]);

class Query {
  constructor(db, table) {
    this.db = db; this.table = table; this.filters = []; this.opts = {};
    this.orderBy = null; this.from = null; this.to = null; this.cap = null; this.one = false;
  }
  select(_cols, opts) { this.opts = opts || {}; return this; }
  eq(c, v) { if (!c.includes(".")) this.filters.push((r) => col(r, c) === v); return this; }
  neq(c, v) { if (!c.includes(".")) this.filters.push((r) => col(r, c) !== v); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? col(r, c) == null : col(r, c) === v)); return this; }
  not() { return this; }
  or(expr) {
    // Only the Meta-lead filter of the ads ROI panel is evaluated; other .or() calls are ignored.
    if (typeof expr === "string" && expr.includes("fbclid.not.is.null")) {
      const preds = [];
      for (const m of expr.matchAll(/(\w+)\.in\.\(([^)]*)\)/g)) preds.push((r) => m[2].split(",").includes(r[m[1]]));
      for (const m of expr.matchAll(/(\w+)\.not\.is\.null/g)) preds.push((r) => r[m[1]] != null);
      this.filters.push((r) => preds.some((p) => p(r)));
    }
    return this;
  }
  in(c, vs) { this.filters.push((r) => vs.includes(col(r, c))); return this; }
  gte(c, v) { this.filters.push((r) => col(r, c) != null && compare(col(r, c), v) >= 0); return this; }
  gt(c, v) { this.filters.push((r) => col(r, c) != null && compare(col(r, c), v) > 0); return this; }
  lt(c, v) { this.filters.push((r) => col(r, c) != null && compare(col(r, c), v) < 0); return this; }
  lte(c, v) { this.filters.push((r) => col(r, c) != null && compare(col(r, c), v) <= 0); return this; }
  order(c, o) { this.orderBy = { c, asc: o?.ascending !== false }; return this; }
  range(a, b) { this.from = a; this.to = b; return this; }
  limit(n) { this.cap = n; return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; return this; }
  then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
  run() {
    let rows = (this.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { c, asc } = this.orderBy;
      rows = [...rows].sort((x, y) => (asc ? 1 : -1) * compare(x[c] ?? "", y[c] ?? ""));
    }
    const count = rows.length;
    if (this.opts.head) return { data: null, error: null, count };
    if (this.from !== null) rows = rows.slice(this.from, Math.min(this.to, this.from + MAX_ROWS - 1) + 1);
    else rows = rows.slice(0, Math.min(this.cap ?? MAX_ROWS, MAX_ROWS));
    if (this.cap !== null && this.from !== null) rows = rows.slice(0, this.cap);
    if (this.one) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null, ...(this.opts.count ? { count } : {}) };
  }
}
const makeSupabase = (db, userId) => ({
  auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
  from: (table) => new Query(db, table),
});

let currentSupabase;
function loadRoute(relativePath) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "next/server") {
      return {
        NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200, headers: new Headers(), json: async () => body }) },
        NextRequest: Request,
      };
    }
    if (request === "@/lib/supabase-server") return { createServerSupabase: async () => currentSupabase };
    if (request === "@/lib/request-auth-context") return { applyPrivateNoStore: (r) => r };
    if (request.startsWith("@/lib/")) return previousLoad.call(this, path.join(repoRoot, "src/lib", request.slice(6)), parent, isMain);
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

/* ───────── shared data set ───────── */
const NOW = new Date("2026-11-03T06:00:00.000Z"); // 10:00 Dubai, 14:00 Shanghai
const PROCESS = ["new", "contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision"];
const BOSS = "boss-1";

// Both loss paths set leads.stage = "lost" (here the fixture keeps the stage it was
// lost from only in the stage_change event, as production does). Every third lost
// lead was lost from negotiation, the rest from contacted; one was lost, reopened
// and lost again from a different stage, and one has no event at all.
function lostEvents(leads) {
  const events = [];
  let n = 0;
  for (const l of leads) {
    if (l.final_status !== "lost") continue;
    l.stage = "lost";
    if (n === 0) { n++; continue; } // no event: counted as unknown
    const from = n % 3 === 0 ? "negotiation" : "contacted";
    events.push({ id: `ev-${n}`, lead_id: l.id, event_type: "stage_change", event_data: { from, to: "lost" }, created_at: "2026-10-10T08:00:00Z" });
    if (n === 1) {
      events.push({ id: "ev-old", lead_id: l.id, event_type: "stage_change", event_data: { from: "new", to: "lost" }, created_at: "2026-09-10T08:00:00Z" });
      events.push({ id: "ev-noise", lead_id: l.id, event_type: "stage_change", event_data: { from: "new", to: "contacted" }, created_at: "2026-09-11T08:00:00Z" });
    }
    n++;
  }
  return events;
}

function buildDb() {
  const leads = [];
  for (let i = 0; i < 2400; i++) {
    const won = i % 23 === 0;
    const lost = !won && i % 31 === 0;
    leads.push({
      id: `lead-${String(i).padStart(5, "0")}`,
      archived: i % 97 === 0,
      assigned_to: [null, "s1", "s2", "s3"][i % 4],
      imported_by: i % 5 === 0 ? "s1" : null,
      source: ["fb", "ins", "website", null][i % 4],
      source_platform: i % 4 === 3 ? "meta" : null,
      stage: PROCESS[i % 7],
      final_status: won ? "won" : lost ? "lost" : null,
      won_at: won ? new Date(Date.UTC(2026, 9, 1 + (i % 33), 8)).toISOString() : null,
      quotation_value: 1000 + (i % 9) * 100,
      win_probability: (i % 10) * 10,
      quality: ["good", "normal", "poor", "pending", null][i % 5],
      ai_quality: null,
      lead_status: i % 11 === 0 ? "dormant" : "active",
      followup_count: i % 3,
      created_at: new Date(Date.UTC(2026, 7, 1) + (i % 90) * 86400000 + (i % 24) * 3600000).toISOString(),
      updated_at: "2026-10-20T08:00:00.000Z",
      last_contact_date: i % 3 === 0 ? null : "2026-10-15T08:00:00.000Z",
      next_followup_date: i % 4 === 0 ? "2026-09-26T19:30:00.000Z" : null,
      customer_name: `C${i}`, phone: `+9715${i}`, campaign_name: null,
    });
  }
  // Boundary leads (23:30 and 00:30 Dubai around the 1 November month change; the
  // first is already 1 November in Shanghai).
  const edge = (id, o) => leads.push({ ...leads[1], id, archived: false, assigned_to: "s1", source: "fb", ...o });
  edge("edge-won-oct", { final_status: "won", stage: "negotiation", won_at: "2026-10-31T17:30:00.000Z", quotation_value: 700 });
  edge("edge-won-nov", { final_status: "won", stage: "negotiation", won_at: "2026-10-31T20:30:00.000Z", quotation_value: 300 });
  // A quote conversion marks the lead won without a stage-change event.
  edge("quote-won", { final_status: "won", stage: "quotation_submitted", won_at: "2026-11-02T08:00:00.000Z", quotation_value: 5000 });
  // Created 22:00 Dubai Sunday 1 Nov (02:00 Shanghai Monday) and 01:00 Dubai Monday 2 Nov.
  edge("sun-late", { created_at: "2026-11-01T18:00:00.000Z", final_status: null, won_at: null, stage: "new" });
  edge("mon-early", { created_at: "2026-11-01T21:00:00.000Z", final_status: null, won_at: null, stage: "new" });
  // No manual quality, AI says "normal": a quality-distribution "normal" AND a valid ads lead.
  edge("ai-normal", { quality: null, ai_quality: "normal", final_status: null, won_at: null, stage: "new" });

  const payments = [];
  for (let i = 0; i < 1200; i++) {
    payments.push({ id: `p-old-${String(i).padStart(4, "0")}`, amount: 1, confirmed: true, voided_at: null, payment_date: "2026-09-15", contract_id: "c1" });
  }
  payments.push({ id: "p-oct-last", amount: 100, confirmed: true, voided_at: null, payment_date: "2026-10-31", contract_id: "c1" });
  payments.push({ id: "p-nov-first", amount: 40, confirmed: true, voided_at: null, payment_date: "2026-11-01", contract_id: "c1" });
  payments.push({ id: "p-void", amount: 999, confirmed: true, voided_at: "2026-11-02T08:00:00Z", payment_date: "2026-11-02", contract_id: "c1" });

  return {
    leads,
    payments,
    profiles: [
      { id: BOSS, role: "boss", full_name: "Boss", email: "b@x", is_active: true },
      { id: "s1", role: "sales", full_name: "Sales One", email: "s1@x", is_active: true },
      { id: "s2", role: "sales", full_name: "Sales Two", email: "s2@x", is_active: true },
      { id: "s3", role: "sales", full_name: "Sales Three", email: "s3@x", is_active: true },
    ],
    contracts: [
      { id: "c1", sales_id: "s1", lead_id: "lead-00001", contract_amount: 50000, status: "active", created_at: "2026-11-02T08:00:00Z" },
      // Quote conversion creates a draft contract; none of these is a signing.
      { id: "c-draft", sales_id: "s1", lead_id: "lead-00002", contract_amount: 90000, status: "draft", created_at: "2026-11-02T09:00:00Z" },
      { id: "c-pend", sales_id: "s2", lead_id: "lead-00003", contract_amount: 80000, status: "pending_approval", created_at: "2026-11-02T10:00:00Z" },
      { id: "c-rej", sales_id: "s2", lead_id: "lead-00005", contract_amount: 70000, status: "rejected", created_at: "2026-11-02T11:00:00Z" },
      { id: "c-term", sales_id: "s3", lead_id: "lead-00006", contract_amount: 60000, status: "terminated", created_at: "2026-11-02T12:00:00Z" },
    ],
    installment_plans: [], tasks: [], kpi_targets: [], quotations: [], lead_workflow_stages: [], v_risk_pool: [],
    business_events: lostEvents(leads), follow_up_logs: [], ad_spend: [],
  };
}

const counted = (db) => db.leads.filter((l) => !l.archived);
const run = async (route, url = "https://app.newme.ae/api/x") => {
  const res = await route.GET(new Request(url));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

const db = buildDb();
currentSupabase = makeSupabase(db, BOSS);
const routes = {};
test.before(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const load = (rel) => loadRoute(rel);
  routes.summary = load("src/app/api/dashboard/summary/route.ts");
  routes.health = load("src/app/api/dashboard/lead-health/route.ts");
  routes.load = load("src/app/api/dashboard/sales-load/route.ts");
  routes.ownership = load("src/app/api/dashboard/team-ownership/route.ts");
  routes.performance = load("src/app/api/dashboard/team-performance/route.ts");
  routes.sources = load("src/app/api/dashboard/lead-sources/route.ts");
  routes.funnel = load("src/app/api/dashboard/pipeline-funnel/route.ts");
  routes.trends = load("src/app/api/dashboard/weekly-trends/route.ts");
  routes.analytics = load("src/app/api/analytics/summary/route.ts");
  routes.ads = load("src/app/api/ads/leads/route.ts");
  routes.adsRoi = load("src/app/api/dashboard/ads-roi/route.ts");
  routes.pipelineList = load("src/app/api/pipeline/list/route.ts");
});
test.after(() => mock.timers.reset());

test("every page reports the same lead total: archived leads excluded, nothing capped at 500/1000", async () => {
  const expected = counted(db).length;
  assert.ok(expected > 2000, "data set must exceed the PostgREST row cap");
  const summary = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-11");
  const health = await run(routes.health);
  const sources = await run(routes.sources);
  const funnel = await run(routes.funnel);
  const analytics = await run(routes.analytics);
  const ads = await run(routes.ads);
  assert.equal(summary.leadStats.total, expected, "dashboard");
  assert.equal(health.totalLeads, expected, "analytics lead health");
  assert.equal(sources.totals.count, expected, "lead sources");
  assert.equal(funnel.totalLeads, expected, "pipeline funnel");
  assert.equal(analytics.leadHealth.totalLeads, expected, "analytics summary");
  assert.equal(ads.leads.length, expected, "/ads attribution rows");
});

test("won, active and overdue are one number on every page", async () => {
  const rows = counted(db);
  const won = rows.filter((l) => l.final_status === "won").length;
  const active = rows.filter((l) => !l.final_status).length;
  const summary = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-11");
  const health = await run(routes.health);
  const sources = await run(routes.sources);
  const funnel = await run(routes.funnel);
  const analytics = await run(routes.analytics);
  assert.equal(summary.leadStats.won, won);
  assert.equal(sources.totals.won, won);
  assert.equal(funnel.stages.find((s) => s.key === "won").count, won);
  assert.equal(analytics.pipelineFunnel.stages.find((s) => s.key === "won").count, won);
  assert.equal(summary.leadStats.active, active);
  assert.equal(health.activeCount, active);
  assert.equal(analytics.leadHealth.activeCount, active);
  // overdue follow-ups: same count, same days late (whole Dubai days) everywhere
  assert.equal(health.overdueTotal, summary.leadStats.followUpOverdue);
  assert.equal(health.overdue[0].overdue_days, analytics.leadHealth.overdue[0].overdue_days);
  // Independent check: whole Dubai calendar days between the due instant and now.
  const dubaiDay = (iso) => Math.floor((Date.parse(iso) + 4 * 3600000) / 86400000);
  const overdueDays = rows
    .filter((l) => !l.final_status)
    .map((l) => {
      const due = l.next_followup_date ?? (l.last_contact_date ? null : new Date(Date.parse(l.created_at) + 48 * 3600000).toISOString());
      return due && Date.parse(due) < NOW.getTime() ? dubaiDay(NOW.toISOString()) - dubaiDay(due) : null;
    })
    .filter((d) => d !== null);
  assert.equal(overdueDays.length, health.overdueTotal);
  assert.equal(health.overdue[0].overdue_days, Math.max(...overdueDays));
  assert.deepEqual(health.qualityBreakdown, summary.leadStats.qualityBreakdown);
});

test("per-person numbers add up to the company numbers", async () => {
  const summary = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-11");
  const ownership = await run(routes.ownership);
  const load = await run(routes.load);
  const perf = await run(routes.performance);
  const rows = counted(db);
  for (const id of ["s1", "s2", "s3"]) {
    const mine = rows.filter((l) => l.assigned_to === id);
    const o = ownership.users.find((u) => u.user_id === id);
    assert.equal(o.assigned_leads, mine.length, `${id} assigned`);
    assert.equal(o.won_leads, mine.filter((l) => l.final_status === "won").length, `${id} won`);
    assert.equal(o.active_leads, mine.filter((l) => !l.final_status).length, `${id} active`);
    assert.equal(summary.leadStats.byAssignee[id].won, o.won_leads);
    assert.equal(load.repStats.find((r) => r.id === id).totalLeads, mine.length);
    assert.equal(load.repStats.find((r) => r.id === id).wonLeads, o.won_leads);
    assert.equal(perf.repStats.find((r) => r.id === id).wonLeads, o.won_leads);
  }
});

test("won in a month is by Dubai month of won_at, quote conversions included", async () => {
  const rows = counted(db).filter((l) => l.final_status === "won");
  const inMonth = (month) => rows.filter((l) => {
    const dubai = new Date(Date.parse(l.won_at) + 4 * 3600000).toISOString().slice(0, 7);
    return dubai === month;
  });
  const nov = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-11");
  const oct = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-10");
  assert.equal(nov.leadStats.periodWonCount, inMonth("2026-11").length);
  assert.equal(oct.leadStats.periodWonCount, inMonth("2026-10").length);
  assert.equal(nov.finance.wonCount, nov.leadStats.periodWonCount);
  // 21:30 Dubai on 31 Oct (01:30 Shanghai 1 Nov) is October; 00:30 Dubai is November.
  assert.ok(inMonth("2026-10").some((l) => l.id === "edge-won-oct"));
  assert.ok(inMonth("2026-11").some((l) => l.id === "edge-won-nov"));
  assert.ok(inMonth("2026-11").some((l) => l.id === "quote-won"));
  // performance compares this month's won, not everything ever won
  assert.equal(nov.leadStats.byAssignee.s1.periodWonValue, inMonth("2026-11").filter((l) => l.assigned_to === "s1").reduce((a, l) => a + l.quotation_value, 0));
  assert.ok(nov.leadStats.byAssignee.s1.wonValue > nov.leadStats.byAssignee.s1.periodWonValue);
});

test("collection for a month uses Dubai calendar dates, every payment row, ledger predicate", async () => {
  const nov = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-11");
  // 31 Oct payment is October's; the voided 999 never counts; 1200 old rows are all read.
  assert.equal(nov.finance.paymentAmount, 40);
  assert.equal(nov.finance.received, 1200 + 100 + 40);
  const oct = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-10");
  assert.equal(oct.finance.paymentAmount, 100);
});

test("weekly trends: a Sunday-night lead belongs to the Dubai week it was created in", async () => {
  const trends = await run(routes.trends);
  const analytics = await run(routes.analytics);
  const week = (body) => body.weeks ?? body.weeklyTrends.weeks;
  const last = week(trends).at(-1);
  const prev = week(trends).at(-2);
  assert.equal(last.start_date, "2026-11-02");
  assert.equal(prev.end_date, "2026-11-01");
  const created = (a, b) => counted(db).filter((l) => l.created_at >= a && l.created_at < b).length;
  // week of 2 Nov Dubai = [1 Nov 20:00Z, 8 Nov 20:00Z)
  assert.equal(last.new_leads, created("2026-11-01T20:00:00.000Z", "2026-11-08T20:00:00.000Z"));
  assert.equal(prev.new_leads, created("2026-10-25T20:00:00.000Z", "2026-11-01T20:00:00.000Z"));
  assert.deepEqual(week(analytics).map((w) => [w.start_date, w.new_leads]), week(trends).map((w) => [w.start_date, w.new_leads]));
});

/* ───────── review round ───────── */
const sumValue = (rows) => rows.reduce((a, l) => a + l.quotation_value, 0);
const dubaiMonth = (iso) => new Date(Date.parse(iso) + 4 * 3600000).toISOString().slice(0, 7);

test("management 'signed' this month = won this month by won_at; draft/pending/rejected/terminated contracts never count", async () => {
  const summary = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-11");
  const wonNov = counted(db).filter((l) => l.final_status === "won" && l.won_at && dubaiMonth(l.won_at) === "2026-11");
  assert.ok(wonNov.length > 0);
  assert.equal(summary.leadStats.periodWonValue, sumValue(wonNov));
  // The weekly-review "signed" tile reads the same figure.
  assert.equal(summary.finance.signedAmount, sumValue(wonNov));
  // 90000 + 80000 + 70000 + 60000 of new-this-month contracts in the fixture, plus the 50000 active one: none of it is added.
  assert.ok(summary.finance.signedAmount < 50000 + 90000 + 80000 + 70000 + 60000);
  // The page: sales and management read the same field family.
  const page = fs.readFileSync(path.join(repoRoot, "src/app/(dashboard)/dashboard/page.tsx"), "utf8");
  assert.match(page, /userRole === "sales" \? mySigningActual : leadStats\.periodWonValue/);
  assert.doesNotMatch(page, /financeStats\.contractAmount/);
});

test("lost-from stage is read from the stage_change event (from -> lost), on the funnel and in analytics", async () => {
  const funnel = await run(routes.funnel);
  const analytics = await run(routes.analytics);
  const lost = counted(db).filter((l) => l.final_status === "lost");
  const latest = new Map();
  for (const e of db.business_events) {
    if (e.event_data.to !== "lost") continue;
    const prev = latest.get(e.lead_id);
    if (!prev || e.created_at > prev.created_at) latest.set(e.lead_id, e);
  }
  const expected = {};
  for (const l of lost) {
    const from = latest.get(l.id)?.event_data.from ?? "unknown";
    expected[from] = (expected[from] || 0) + 1;
  }
  assert.ok(lost.length > 20 && expected.negotiation > 0 && expected.contacted > 0 && expected.unknown === 1);
  assert.equal(funnel.lostFromStage.lost, undefined, "never 'lost: N'");
  assert.deepEqual(funnel.lostFromStage, expected);
  assert.deepEqual(analytics.pipelineFunnel.lostFromStage, expected);
  assert.equal(Object.values(expected).reduce((a, b) => a + b, 0), funnel.stages.find((s) => s.key === "lost").count);
});

test("the Ads ROI panel reads every lead, 'normal' has its own column, one definition of won and quality", async () => {
  const roi = await run(routes.adsRoi);
  const analytics = await run(routes.analytics);
  const ads = await run(routes.ads);
  const rows = counted(db);
  const table = roi.source_quality;
  assert.equal(table.reduce((a, r) => a + r.total, 0), rows.length, "past the 1000-row cap, archived excluded");
  const sum = (key) => table.reduce((a, r) => a + r[key], 0);
  assert.equal(sum("good") + sum("normal") + sum("pending") + sum("bad"), rows.length);
  assert.ok(sum("normal") > 0);
  const summary = await run(routes.summary, "https://app.newme.ae/api/dashboard/summary?month=2026-11");
  const dist = summary.leadStats.qualityBreakdown;
  assert.equal(sum("normal"), dist.normal, "same 'normal' as the quality distribution");
  assert.equal(sum("good"), dist.good);
  // the analytics copy of the table is the same table
  assert.deepEqual(analytics.adsRoi.source_quality, table);
  // 'valid' on the ads pages = good + normal of the same distribution (AI quality is the fallback)
  const { aggregateAttribution, totalAttribution } = await import("../../src/lib/lead-metrics.mjs");
  const totals = totalAttribution(aggregateAttribution(ads.leads));
  assert.equal(totals.valid, dist.good + dist.normal);
  // won amount: the meta leads' won quotation value, one definition
  const isMeta = (l) => l.source === "fb" || l.source === "ins" || l.source_platform === "meta";
  const metaWon = rows.filter((l) => isMeta(l) && l.final_status === "won");
  assert.equal(roi.summary.conversions, metaWon.length);
  assert.equal(roi.summary.signed_amount, sumValue(metaWon));
  assert.equal(roi.summary.total_leads, rows.filter(isMeta).length);
});

test("'won amount' is one number across the sales load, team performance and lead sources pages", async () => {
  const load = await run(routes.load);
  const perf = await run(routes.performance);
  const sources = await run(routes.sources);
  const analytics = await run(routes.analytics);
  const rows = counted(db);
  for (const id of ["s1", "s2", "s3"]) {
    const expected = sumValue(rows.filter((l) => l.assigned_to === id && l.final_status === "won"));
    assert.equal(load.repStats.find((r) => r.id === id).wonAmount, expected, `${id} sales load`);
    assert.equal(perf.repStats.find((r) => r.id === id).revenue, expected, `${id} team performance`);
    assert.equal(analytics.salesLoad.repStats.find((r) => r.id === id).wonAmount, expected, `${id} analytics`);
  }
  const teamWon = sumValue(rows.filter((l) => ["s1", "s2", "s3"].includes(l.assigned_to) && l.final_status === "won"));
  assert.equal(perf.team.revenue, teamWon);
  assert.equal(perf.sources.reduce((a, r) => a + r.revenue, 0), teamWon);
  // Contracts (drafts, pending, rejected, terminated) have no say in it.
  assert.equal(sources.sources.reduce((a, r) => a + r.revenue, 0), sumValue(rows.filter((l) => l.final_status === "won")), "lead sources");
});

test("weekly 'signed' amount is the lead won amount by won_at week, on both trend endpoints", async () => {
  const trends = await run(routes.trends);
  const analytics = await run(routes.analytics);
  const week = (body) => body.weeks ?? body.weeklyTrends.weeks;
  const last = week(trends).at(-1);
  const wonIn = (a, b) => counted(db).filter((l) => l.final_status === "won" && l.won_at >= a && l.won_at < b);
  // week of 2 Nov Dubai = [1 Nov 20:00Z, 8 Nov 20:00Z)
  const expected = sumValue(wonIn("2026-11-01T20:00:00.000Z", "2026-11-08T20:00:00.000Z"));
  assert.ok(expected >= 5000, "the quote-conversion win of 2 Nov is in it");
  assert.equal(last.signed_amount, expected);
  assert.equal(week(analytics).at(-1).signed_amount, expected);
  assert.deepEqual(week(analytics).map((w) => w.signed_amount), week(trends).map((w) => w.signed_amount));
});

test("a sales rep's KPI actuals are the Dubai month's won amount and cash, the same as the dashboard", async () => {
  currentSupabase = makeSupabase(db, "s1");
  try {
    const body = await run(routes.pipelineList);
    const wonNov = counted(db).filter((l) => l.assigned_to === "s1" && l.final_status === "won" && l.won_at && dubaiMonth(l.won_at) === "2026-11");
    assert.ok(wonNov.length > 0);
    assert.equal(body.kpiData.signingActual, sumValue(wonNov));
    assert.equal(body.kpiData.contractCount, wonNov.length);
    // only the 1 Nov payment (40); 31 Oct (100) and the voided one are not November cash
    assert.equal(body.kpiData.collectionActual, 40);
    const summary = await (async () => {
      const r = await routes.summary.GET(new Request("https://app.newme.ae/api/dashboard/summary?month=2026-11"));
      return r.body;
    })();
    assert.equal(body.kpiData.signingActual, summary.leadStats.byAssignee.s1.periodWonValue);
  } finally {
    currentSupabase = makeSupabase(db, BOSS);
  }
});
