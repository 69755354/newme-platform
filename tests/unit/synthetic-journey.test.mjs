// S7 item 4: the daily production journey must never touch anything but the one
// pinned, marked test lead, and must always put it back.
import assert from "node:assert/strict";
import test from "node:test";
import { SyntheticAbort, assertSafeSyntheticLead, formatReport, loadConfig, runJourney } from "../../scripts/synthetic-journey.mjs";

const LEAD = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";
const AWAY = "33333333-3333-4333-8333-333333333333";
const REAL = "44444444-4444-4444-8444-444444444444";
const ENV = {
  SYNTH_BASE_URL: "https://app.newme.ae", SYNTH_QA_EMAIL: "qa@example.com", SYNTH_QA_PASSWORD: "pw", SYNTH_LEAD_ID: LEAD,
  SYNTH_LEAD_MARKER: "ZZ-QA-SYNTHETIC-DO-NOT-TOUCH", SYNTH_LEAD_SOURCE: "synthetic_qa", SYNTH_HOME_ASSIGNEE_ID: HOME, SYNTH_AWAY_ASSIGNEE_ID: AWAY,
};
const config = loadConfig(ENV);

function fakeApp({ breakStage = false, breakRevert = false, lead: leadOverride = {} } = {}) {
  const state = {
    lead: { id: LEAD, customer_name: ENV.SYNTH_LEAD_MARKER, source: "synthetic_qa", assigned_to: HOME, stage: "new", updated_at: "2026-11-05T01:00:00.000000+00:00", ...leadOverride },
    real: { id: REAL, customer_name: "Real Customer", source: "meta", assigned_to: HOME, stage: "new", updated_at: "2026-11-05T01:00:00.000000+00:00" },
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
        if (breakStage && body.stage !== "new") return reply({ error: "boom" }, 500);
        target.stage = body.stage;
      }
      target.updated_at = new Date().toISOString();
      return reply({ success: true });
    }
    return reply({}, 404);
  };
  return { state, fetchImpl };
}

test("happy path changes assignee and stage, then restores both", async () => {
  const app = fakeApp();
  const result = await runJourney({ config, fetchImpl: app.fetchImpl });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(app.state.lead.assigned_to, HOME);
  assert.equal(app.state.lead.stage, "new");
  assert.ok(app.state.writes.every(([, id]) => id === LEAD), "only the pinned lead was written");
  assert.deepEqual(app.state.writes.map(([, , kind]) => kind), ["assignment", "stage", "stage", "assignment"]);
  assert.equal(result.release, "abc1234");
  assert.match(formatReport(result, config), /PASSED \(release abc1234\)/);
  assert.equal(app.state.real.stage, "new");
});

test("a failure after the first write still reverts and reports the failed step", async () => {
  const app = fakeApp({ breakStage: true });
  const result = await runJourney({ config, fetchImpl: app.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "stage");
  assert.equal(result.critical, false);
  assert.equal(app.state.lead.assigned_to, HOME, "assignment was put back");
  assert.match(formatReport(result, config), /FAILED .* at step "stage"/);
});

test("a revert that fails is CRITICAL", async () => {
  const app = fakeApp({ breakRevert: true });
  const result = await runJourney({ config, fetchImpl: app.fetchImpl });
  assert.equal(result.critical, true);
  assert.match(formatReport(result, config), /CRITICAL/);
});

for (const [label, override] of [
  ["wrong marker name", { customer_name: "Real Customer" }],
  ["wrong source", { source: "meta" }],
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
  assert.throws(() => assertSafeSyntheticLead({ id: REAL, customer_name: ENV.SYNTH_LEAD_MARKER, source: "synthetic_qa", assigned_to: HOME }, config), SyntheticAbort);
});

test("configuration refuses http, equal assignees and short markers", () => {
  assert.throws(() => loadConfig({ ...ENV, SYNTH_BASE_URL: "http://app.newme.ae" }), /https/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_AWAY_ASSIGNEE_ID: HOME }), /differ/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_LEAD_MARKER: "test" }), /marker/);
  assert.throws(() => loadConfig({ ...ENV, SYNTH_QA_PASSWORD: "" }), /SYNTH_QA_PASSWORD/);
});

test("the report never contains credentials, names or cookies", async () => {
  const app = fakeApp({ breakStage: true });
  const result = await runJourney({ config, fetchImpl: app.fetchImpl });
  const text = formatReport(result, config) + JSON.stringify(result);
  for (const secret of ["pw", "token123", "qa@example.com", "Real Customer", ENV.SYNTH_LEAD_MARKER]) {
    assert.ok(!text.includes(secret) || secret === "pw" && !/\bpw\b/.test(text), `leaked ${secret}`);
  }
});
