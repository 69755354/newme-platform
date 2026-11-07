// S7 item 1: "any NEW production error -> notify immediately" as code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyRules, planRules } from "../../scripts/sentry-apply-alert-rules.mjs";

const spec = JSON.parse(readFileSync(new URL("../../infra/sentry/alert-rules.json", import.meta.url), "utf8"));
const spike = { name: spec.copyActionsFrom, actions: [{ id: "email" }, { id: "webhook-telegram" }] };

test("spec has a first-seen rule, scoped to production, with no inline destinations", () => {
  const first = spec.rules.find((r) => r.conditions.some((c) => c.id.endsWith("FirstSeenEventCondition")));
  assert.ok(first, "first-seen rule present");
  assert.ok(spec.rules.every((r) => r.environment === "production"));
  assert.ok(spec.rules.every((r) => !("actions" in r)), "destinations are copied from the live rule, never stored in git");
  assert.ok(first.frequency <= 5, "notified within five minutes");
});

test("plan copies actions from the existing rule and skips rules that already exist", () => {
  const plan = planRules(spec, [spike, { name: spec.rules[0].name, actions: [] }]);
  assert.deepEqual(plan.skipped, [spec.rules[0].name]);
  assert.equal(plan.create.length, spec.rules.length - 1);
  assert.deepEqual(plan.create[0].actions, spike.actions);
});

test("dry run posts nothing; apply posts each missing rule; missing source rule is an error", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push([init.method ?? "GET", url]); return Response.json(init.method === "POST" ? {} : [spike]); };
  await applyRules(spec, { fetchImpl, token: "t", apply: false });
  assert.deepEqual(calls.map((c) => c[0]), ["GET"]);
  calls.length = 0;
  await applyRules(spec, { fetchImpl, token: "t", apply: true });
  assert.equal(calls.filter((c) => c[0] === "POST").length, spec.rules.length);
  await assert.rejects(applyRules(spec, { fetchImpl: async () => Response.json([]), token: "t", apply: true }), /no actions to copy/);
});
