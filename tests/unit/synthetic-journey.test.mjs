// S7 item 4 (reworked after review): production runs read-only; the full journey runs
// on staging against one pinned, marked test lead, whose assignee it always puts back.
import assert from "node:assert/strict";
import test from "node:test";
import { SyntheticAbort, assertSafeSyntheticLead, formatReport, loadConfig, releaseInProgress, runJourney } from "../../scripts/synthetic-journey.mjs";

const LEAD = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";
const AWAY = "33333333-3333-4333-8333-333333333333";
const REAL = "44444444-4444-4444-8444-444444444444";
const ENV = {
  SYNTH_MODE: "staging", SYNTH_STAGING_HOSTS: "staging.example.test", SYNTH_BASE_URL: "https://staging.example.test", SYNTH_QA_EMAIL: "qa@example.com", SYNTH_QA_PASSWORD: "pw", SYNTH_LEAD_ID: LEAD,
  SYNTH_LEAD_MARKER: "ZZ-QA-SYNTHETIC-DO-NOT-TOUCH", SYNTH_LEAD_SOURCE: "other", SYNTH_HOME_ASSIGNEE_ID: HOME, SYNTH_AWAY_ASSIGNEE_ID: AWAY,
};
const config = loadConfig(ENV);
const stageConfig = loadConfig({ ...ENV, SYNTH_ONEWAY_STAGE: "1" });
const PROD_ENV = { SYNTH_BASE_URL: "https://app.newme.ae", SYNTH_QA_EMAIL: "qa@example.com", SYNTH_QA_PASSWORD: "pw" };

const STAGE_ORDER = ["new", "contacted", "qualified", "won"];

function fakeApp({ breakStage = false, breakRevert = false, lead: leadOverride = {} } = {}) {
  const state = {
    lead: { id: LEAD, customer_name: ENV.SYNTH_LEAD_MARKER, source: "other", assigned_to: HOME, stage: "new", updated_at: "2026-11-05T01:00:00.000000+00:00", ...leadOverride },
    real: { id: REAL, customer_name: "Real Customer", source: "fb", assigned_to: HOME, stage: "new", updated_at: "2026-11-05T01:00:00.000000+00:00" },
    writes: [],
  };
  const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (path === "/api/auth/login") {
      const h = new Headers({ "set-cookie": "sb-auth=token123; Path=/; HttpOnly" });
      return new Response("{}", { status: 200, headers: h });
    }
    if (path === "/api/auth/logout") return reply({});
    if (path === "/api/leads/list") return reply({ leads: [state.real, state.lead], salesUsers: [{ id: HOME }, { id: AWAY }] }, 200, { "x-newme-release": "abc1234" });
    const m = path.match(/^\/api\/leads\/([^/]+)\/(assignment|stage)$/);
    if (m) {
      state.writes.push([method, m[1], m[2]]);
      const body = JSON.parse(init.body);
      const target = m[1] === LEAD ? state.lead : state.real;
      if (m[2] === "assignment") {
        if (breakRevert && body.reason === "synthetic_journey_revert") return reply({ error: "boom" }, 500);
        target.assigned_to = body.assignedTo;
      } else {
        // Real rule (transition_lead_stage): stages only move forward.
        if (STAGE_ORDER.indexOf(body.stage) <= STAGE_ORDER.indexOf(target.stage)) return reply({ error: "stage_regression_not_allowed" }, 409);
        if (breakStage) return reply({ error: "boom" }, 500);
        target.stage = body.stage;
      }
      target.updated_at = new Date().toISOString();
      return reply({ success: true });
    }
    return reply({}, 404);
  };
  return { state, fetchImpl };
}

test("staging happy path assigns the pinned lead away and back and never writes elsewhere", async () => {
  const app = fakeApp();
  const result = await runJourney({ config, fetchImpl: app.fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(app.state.lead.assigned_to, HOME);
  assert.equal(app.state.lead.stage, "new", "no stage step unless explicitly enabled");
  assert.ok(app.state.writes.every(([, id]) => id === LEAD), "only the pinned lead was written");
  assert.deepEqual(app.state.writes.map(([, , kind]) => kind), ["assignment", "assignment"]);
  assert.equal(result.release, "abc1234");
  assert.match(formatReport(result, config), /staging journey PASSED \(release abc1234\)/);
  assert.equal(app.state.real.stage, "new");
});

test("one-way stage step moves forward once and is never reverted (the real rules refuse a regression)", async () => {
  const app = fakeApp();
  const result = await runJourney({ config: stageConfig, fetchImpl: app.fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.critical, false, "no revert attempt, so no daily CRITICAL");
  assert.equal(app.state.lead.stage, "contacted");
  assert.equal(app.state.lead.assigned_to, HOME);
  assert.deepEqual(app.state.writes.map(([, , kind]) => kind), ["assignment", "stage", "assignment"]);
  // Running again on the same lead fails early with a clear reason instead of a bogus alert.
  const again = await runJourney({ config: stageConfig, fetchImpl: app.fetchImpl });
  assert.equal(again.ok, false);
  assert.match(again.error, /already in the target stage/);
  assert.equal(again.critical, false);
});

test("a failure after the first write still restores the assignee and reports the failed step", async () => {
  const app = fakeApp({ breakStage: true });
  const result = await runJourney({ config: stageConfig, fetchImpl: app.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "stage");
  assert.equal(result.critical, false);
  assert.equal(app.state.lead.assigned_to, HOME, "assignment was put back");
  assert.match(formatReport(result, stageConfig), /FAILED .* at step "stage"/);
});

test("a revert that fails is CRITICAL", async () => {
  const app = fakeApp({ breakRevert: true });
  const result = await runJourney({ config, fetchImpl: app.fetchImpl });
  assert.equal(result.critical, true);
  assert.match(formatReport(result, config), /CRITICAL/);
});

function productionApp({ leads = [{ id: REAL }], listStatus = 200, detailStatus = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    requests.push([method, path]);
    if (path === "/api/auth/login") return new Response("{}", { status: 200, headers: { "set-cookie": "sb-auth=token123; Path=/; HttpOnly" } });
    if (path === "/api/auth/logout") return new Response("{}");
    if (path === "/api/leads/list") return new Response(JSON.stringify({ leads, salesUsers: [] }), { status: listStatus, headers: { "x-newme-release": "abc1234" } });
    if (path === `/api/leads/${REAL}/timeline`) return new Response("[]", { status: detailStatus });
    return new Response("{}", { status: 404 });
  };
  return { requests, fetchImpl };
}

test("production journey writes no business data: only login, GET list, GET one timeline, logout -- no write, no test lead needed", async () => {
  const prod = loadConfig(PROD_ENV);
  assert.equal(prod.mode, "production");
  assert.equal(prod.leadId, undefined, "production needs no pinned test lead");
  const app = productionApp();
  const result = await runJourney({ config: prod, fetchImpl: app.fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(app.requests, [
    ["POST", "/api/auth/login"],
    ["GET", "/api/leads/list"],
    ["GET", `/api/leads/${REAL}/timeline`],
    ["POST", "/api/auth/logout"],
  ]);
  assert.ok(app.requests.every(([method, path]) => method === "GET" || path.startsWith("/api/auth/")), "the only non-GET calls are login and logout");
  assert.match(formatReport(result, prod), /Daily production check PASSED \(release abc1234\)/);
});

test("production journey fails (and says why) when the list or the detail cannot be read, or the account sees no leads", async () => {
  const prod = loadConfig(PROD_ENV);
  let result = await runJourney({ config: prod, fetchImpl: productionApp({ listStatus: 500 }).fetchImpl });
  assert.deepEqual([result.ok, result.failedStep], [false, "open_leads"]);
  result = await runJourney({ config: prod, fetchImpl: productionApp({ detailStatus: 500 }).fetchImpl });
  assert.deepEqual([result.ok, result.failedStep], [false, "open_lead_detail"]);
  result = await runJourney({ config: prod, fetchImpl: productionApp({ leads: [] }).fetchImpl });
  assert.deepEqual([result.ok, result.failedStep], [false, "open_lead_detail"]);
  assert.match(result.error, /needs lead read access/);
  assert.equal(result.critical, false);
});

test("staging mode only runs against an allow-listed staging host; unknown modes are refused", () => {
  assert.throws(() => loadConfig({ ...ENV, SYNTH_BASE_URL: "https://app.newme.ae" }), /only runs against a host listed/);
  // Bypasses of a "not production" deny-list: trailing dot, other case, raw IP, port tricks.
  for (const url of ["https://app.newme.ae./", "https://APP.NEWME.AE", "https://203.0.113.10", "https://staging.example.test.evil.test", "https://evil.test@app.newme.ae"]) {
    assert.throws(() => loadConfig({ ...ENV, SYNTH_BASE_URL: url }), SyntheticAbort, url);
  }
  assert.equal(loadConfig({ ...ENV, SYNTH_BASE_URL: "https://STAGING.example.test/" }).mode, "staging");
  assert.throws(() => loadConfig({ ...ENV, SYNTH_STAGING_HOSTS: "app.newme.ae" }), /plain staging host names/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_STAGING_HOSTS: "203.0.113.10" }), /plain staging host names/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_STAGING_HOSTS: "" }), /SYNTH_STAGING_HOSTS/);
  assert.throws(() => loadConfig({ ...PROD_ENV, SYNTH_MODE: "full" }), /SYNTH_MODE/);
});

test("production check is skipped (not failed) while the release lock is held, and never holds the lock itself", () => {
  const calls = [];
  const busy = releaseInProgress({ path: "/x/lock", spawn: (cmd, args) => { calls.push([cmd, ...args]); return { status: 1 }; } });
  assert.equal(busy, true);
  assert.deepEqual(calls[0], ["flock", "-n", "/x/lock", "-c", "true"], "try-and-release: the lock is not held during the check");
  assert.equal(releaseInProgress({ spawn: () => ({ status: 0 }) }), false);
  assert.equal(releaseInProgress({ spawn: () => ({ status: null, error: new Error("no flock") }) }), false, "a tool problem must not silently skip forever");
});

test("the command line skips with exit 0 and no request when the lock is busy", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "synth-lock-"));
  const lock = join(dir, "release.lock");
  writeFileSync(lock, "");
  const holder = spawnSync("bash", ["-c", `exec 9>"${lock}"; flock -n 9 && node scripts/synthetic-journey.mjs`], {
    encoding: "utf8", env: { ...process.env, ...PROD_ENV, SYNTH_BASE_URL: "https://127.0.0.1:1", SYNTH_RELEASE_LOCK: lock },
  });
  // Here the shell holds the lock and the child cannot take it: skipped, exit 0.
  assert.equal(holder.status, 0, holder.stderr);
  assert.match(holder.stdout, /release in progress/);
});

for (const [label, override] of [
  ["wrong marker name", { customer_name: "Real Customer" }],
  ["wrong source", { source: "fb" }],
  ["assigned to a real salesperson", { assigned_to: REAL }],
]) {
  test(`aborts before any write when the pinned lead has the ${label}`, async () => {
    const app = fakeApp({ lead: override });
    const result = await runJourney({ config, fetchImpl: app.fetchImpl });
    assert.equal(result.ok, false);
    assert.deepEqual(app.state.writes, [], "no write may happen");
  });
}

test("the guard rejects a lead id that is not the pinned one", () => {
  assert.throws(() => assertSafeSyntheticLead({ id: REAL, customer_name: ENV.SYNTH_LEAD_MARKER, source: "other", assigned_to: HOME }, config), SyntheticAbort);
});

test("configuration refuses http, equal assignees and short markers", () => {
  assert.throws(() => loadConfig({ ...ENV, SYNTH_BASE_URL: "http://staging.example.test" }), /https/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_AWAY_ASSIGNEE_ID: HOME }), /differ/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_LEAD_MARKER: "test" }), /marker/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_QA_PASSWORD: "" }), /SYNTH_QA_PASSWORD/);
});

test("the report never contains credentials, names or cookies", async () => {
  const app = fakeApp({ breakStage: true });
  const result = await runJourney({ config: stageConfig, fetchImpl: app.fetchImpl });
  const text = formatReport(result, stageConfig) + JSON.stringify(result);
  for (const secret of ["pw", "token123", "qa@example.com", "Real Customer", ENV.SYNTH_LEAD_MARKER]) {
    assert.ok(!text.includes(secret) || secret === "pw" && !/\bpw\b/.test(text), `leaked ${secret}`);
  }
});
