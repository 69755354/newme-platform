import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("only completed milestone rows contribute to Lead completion views", async () => {
  const quality = await read("src/app/api/dashboard/quality/route.ts");
  const commandCenter = await read("src/app/api/command-center/route.ts");
  const timeline = await read("src/app/api/leads/[id]/timeline/route.ts");

  assert.match(
    quality,
    /\.eq\("milestone_key", "first_contact"\)\s*\.not\("completed_at", "is", null\)/,
  );
  assert.match(
    quality,
    /\.eq\("lead_milestones\.milestone_key", "first_contact"\)\s*\.not\("lead_milestones\.completed_at", "is", null\)\s*\.is\("lead_milestones", null\)/,
  );
  assert.match(
    commandCenter,
    /\.from\('lead_milestones'\)[\s\S]*?\.select\('id, lead_id'\)\s*\.not\('completed_at', 'is', null\)/,
  );
  assert.match(
    timeline,
    /\.from\("lead_milestones"\)\.select\("\*"\)\.eq\("lead_id", leadId\)\.not\("completed_at", "is", null\)/,
  );
});

test("active Leads with no completed milestone remain in funnel facts as new", async () => {
  const funnel = await read("src/app/api/dashboard/pipeline-funnel/route.ts");
  const snapshot = await read("src/app/api/cron/daily-funnel-snapshot/route.ts");

  assert.match(funnel, /normalizeMilestone\(l\.current_milestone \|\| "new"\)/);
  assert.match(snapshot, /normalizeMilestone\(lead\.current_milestone \|\| 'new'\)/);
  assert.doesNotMatch(snapshot, /if \(!lead\.current_milestone\) continue/);
  assert.match(
    snapshot,
    /\.select\('current_milestone'\)\s*\.eq\('organization_id', organization\.id\)\s*\.is\('final_status', null\)\s*\.eq\('archived', false\)/,
  );
});

test("First Contact reopen rolls back to new without silent auto-completion", async () => {
  const migration = await read(
    "supabase/migrations/20260719000000_fix_reopen_fact_consistency.sql",
  );

  assert.match(migration, /SET current_milestone = COALESCE\(previous_key, 'new'\)/);
  assert.match(migration, /milestone_key = 'first_contact'[\s\S]*completed_at IS NULL/);
  assert.match(migration, /DROP TRIGGER IF EXISTS trg_first_contact_from_quality ON public\.leads/);
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.trg_auto_first_contact_from_quality\(\)/);
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.complete_first_contact_if_ready\(uuid\)/);
  assert.doesNotMatch(migration, /DROP FUNCTION IF EXISTS public\.recomplete_lead_milestone/);
});

test("reopen preserves evidence and explicit recompletion remains authoritative", async () => {
  const migration = await read(
    "supabase/migrations/20260719000000_fix_reopen_fact_consistency.sql",
  );
  const route = await read("src/app/api/leads/[id]/milestone/route.ts");

  assert.match(migration, /SET completed_at = NULL,\s*completed_by = NULL/);
  assert.match(migration, /'action', 'milestone_reopened'/);
  assert.match(migration, /'reason', clean_reason/);
  assert.match(migration, /'affected', COALESCE\(affected, '\[\]'::jsonb\)/);
  assert.match(route, /"recomplete_lead_milestone"/);
});

test("legacy quality-trigger recompletion yields to the latest explicit reopen audit", async () => {
  const reconciliation = await read(
    "supabase/migrations/20260719010000_reconcile_legacy_reopened_milestones.sql",
  );

  assert.match(reconciliation, /event_data->>'action' IN \('milestone_reopened', 'milestone_recompleted'\)/);
  assert.match(
    reconciliation,
    /event_data->'affected' @> jsonb_build_array\(\s*jsonb_build_object\('milestone_key', lm\.milestone_key\)\s*\)/,
  );
  assert.match(reconciliation, /ORDER BY lead_milestone_id, be\.created_at DESC, be\.id DESC/);
  assert.match(reconciliation, /latest_action = 'milestone_reopened'/);
  assert.match(reconciliation, /AND lm\.completed_at IS NOT NULL/);
  assert.match(reconciliation, /SET completed_at = NULL,\s*completed_by = NULL/);
  assert.match(reconciliation, /RETURNING lm\.id, lm\.lead_id/);
  assert.match(reconciliation, /FROM reopened_rows rr\s*WHERE rr\.id = lm\.id/);
  assert.doesNotMatch(reconciliation, /SET[^;]*\bnotes\s*=/s);
  assert.match(reconciliation, /COALESCE\(remaining\.milestone_key, 'new'\)/);
});
