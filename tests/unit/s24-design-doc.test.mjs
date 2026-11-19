import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const doc = fs.readFileSync(new URL("../../docs/s24-dispatch-review.md", import.meta.url), "utf8");

test("the S24 design names the tables, the seven dispatch states and the routines", () => {
  for (const needle of ["public.lead_dispatch_state", "public.duplicate_reviews", "public.lead_dispatch_events",
    "delivered", "missing_intake_data", "review_phone", "unassigned", "duplicate_review", "duplicate_not_dispatched",
    "excluded_test", "evaluate_lead_dispatch", "resolve_duplicate_review", "dispatch_decide",
    "sweep_lead_dispatch", "Row-level security", "s24-db-plan", "s24-db-provision"]) {
    assert.ok(doc.includes(needle), `design doc is missing: ${needle}`);
  }
});

test("the design fixes the evaluation order and who may decide", () => {
  assert.match(doc, /## Automatic evaluation/);
  assert.match(doc, /Evaluation order/);
  assert.match(doc, /admin, boss and operator/);
  assert.match(doc, /admin and boss are equal/i);
  assert.match(doc, /sales .* read only their own/i);
});

test("the design keeps the leads table untouched and sends no Meta feedback or notification", () => {
  assert.match(doc, /No column is added to `public\.leads`/);
  assert.match(doc, /does not send Meta feedback/i);
  assert.match(doc, /creates no notification/i);
  assert.match(doc, /Show room, FB and ins/);
});

test("WhatsApp leads, the backfill gate and the rollout order are described", () => {
  assert.match(doc, /WhatsApp/);
  assert.match(doc, /backfill/i);
  assert.match(doc, /not in the application/i);
  assert.match(doc, /## Rollout order/);
});

test("the document carries no customer data", () => {
  assert.doesNotMatch(doc, /\+971\d{6,}|@[a-z0-9-]+\.(com|ae)\b/i);
});
