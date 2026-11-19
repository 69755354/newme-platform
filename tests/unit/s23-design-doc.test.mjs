import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const doc = fs.readFileSync(new URL("../../docs/s23-opportunities-visits.md", import.meta.url), "utf8");

test("the S23 design names both tables, the state machine, RLS and the rollout order", () => {
  for (const needle of ["public.opportunities", "public.visit_reports", "public.opportunity_stages",
    "planned", "approved", "completed", "reviewed", "overdue", "Row-level security", "s23-db-plan", "s23-db-provision"]) {
    assert.ok(doc.includes(needle), `design doc is missing: ${needle}`);
  }
});

test("the design records the decisions the brief fixed", () => {
  assert.match(doc, /Monday to Friday/);
  assert.match(doc, /admin and boss are equal/i);
  assert.match(doc, /Show room, FB and ins/);
  assert.match(doc, /does not send Meta feedback/i);
});

test("the sheet column mapping lists column names only, no sample values", () => {
  assert.match(doc, /## Mapping from the Drive sheets/);
  assert.doesNotMatch(doc, /\+971\d{6,}|@[a-z0-9-]+\.(com|ae)\b/i);
});
