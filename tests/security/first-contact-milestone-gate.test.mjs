import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("First Contact milestone API enforces contact plus quality before insert", async () => {
  const source = await read("src/app/api/leads/[id]/milestone/route.ts");
  const gate = source.indexOf('milestoneKey === "first_contact"');
  const insert = source.indexOf('.from("lead_milestones")');

  assert.notEqual(gate, -1, "first_contact milestone must have a dedicated server gate");
  assert.match(source, /from\("follow_up_logs"\)/);
  assert.match(source, /contact_result/);
  assert.match(source, /quality/);
  assert.ok(gate < insert, "First Contact gate must run before milestone insert");
});

test("First Contact checkbox cannot bypass the business gate", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(source, /firstContactBlocked/);
  assert.match(source, /disabled=\{locked \|\| firstContactBlocked\}/);
  assert.match(source, /if \(locked \|\| firstContactBlocked\) return;/);
});

test("First Contact workspace remains available after milestone completion", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(source, /key === "first_contact" && \(isNext \|\| completed\)/);
});

test("database rejects direct First Contact milestone bypass", async () => {
  const migration = await read("supabase/migrations/20260714000000_enforce_first_contact_milestone_gate.sql");
  assert.match(migration, /BEFORE INSERT ON public\.lead_milestones/);
  assert.match(migration, /NEW\.milestone_key = 'first_contact'/);
  assert.match(migration, /public\.follow_up_logs/);
  assert.match(migration, /quality NOT IN \('good', 'normal', 'poor'\)/);
});
