// S3 #1 — completing milestones never advanced the lead stage: a lead with all
// seven milestones done still showed "New lead" on the kanban and in every
// stage-based number. 20261104120100 advances the stage in the same
// transaction as the milestone, using the milestone -> stage mapping the app
// already reports to Meta, one audited step at a time, never past the
// first-contact gate, never on won/lost leads.
//
// This file holds the static checks. The behaviour proof is
// tests/database/milestone-stage-advance.sh (like the other tests/database
// scripts it needs a throwaway PostgreSQL, so it is run separately, not by
// npm test).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = "supabase/migrations/20261104120100_milestone_completion_advances_lead_stage.sql";
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("the SQL mapping is the app's milestone -> stage mapping (same Meta funnel event)", () => {
  const sql = read(MIGRATION);
  const events = Object.fromEntries(
    [...read("src/lib/meta-crm-events.ts").matchAll(/^\s+(\w+): "([^"]+)",$/gm)].map((m) => [m[1], m[2]]),
  );
  const pairs = [...sql.matchAll(/when '(\w+)' then '(\w+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, [
    ["first_contact", "contacted"],
    ["requirements", "requirement_confirmed"],
    ["solution", "solution_submitted"],
    ["quotation", "quotation_submitted"],
  ]);
  for (const [milestone, stage] of pairs) {
    assert.ok(events[milestone], milestone);
    assert.equal(events[milestone], events[stage], `${milestone} and ${stage} must report the same funnel event`);
  }
});

test("the migration is atomic, forward-only, gated and pinned", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /after insert or update of completed_at, notes on public\.lead_milestones/);
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public, pg_temp/g);
  assert.equal((sql.match(/set search_path = pg_catalog, public, pg_temp/g) ?? []).length, 2);
  assert.match(sql, /revoke all on function public\.advance_lead_stage_from_milestones\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(sql, /v_current in \('won', 'lost'\)/);
  assert.match(sql, /v_current = 'new' and \(/);
  assert.match(sql, /stage_order\[v_cur_idx \+ 1\]/);
  assert.match(sql, /'stage_change'/);
  assert.match(sql, /ROLLBACK/);
  assert.match(sql, /drop trigger if exists trg_milestone_advances_lead_stage/);
});

test("the database behaviour scenario and its runner are committed", () => {
  const scenario = read("tests/database/milestone-stage-advance.sql");
  assert.match(scenario, /^begin;/m);
  assert.match(scenario, /^rollback;/m);
  assert.doesNotMatch(scenario, /^commit;/m);
  assert.match(read("tests/database/milestone-stage-advance.sh"), /after_all\|quotation_submitted/);
});
