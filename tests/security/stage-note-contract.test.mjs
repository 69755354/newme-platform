import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("stage API validates and records optional stage context", async () => {
  const source = await read("src/app/api/leads/[id]/stage/route.ts");
  assert.ok(source.includes('const note = String(body?.note ?? "").trim()'));
  assert.ok(source.includes("note.length > 1000"));
  assert.ok(source.includes("Stage note must be 1000 characters or fewer"));
  const migration = await read("supabase/migrations/20260714000003_atomic_stage_transition.sql");
  assert.ok(migration.includes("jsonb_build_object('from', current_lead.stage, 'to', p_next_stage)"));
});

test("sales process sends the same note for normal, won, and lost transitions", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.ok(source.includes("Stage note (optional)"));
  assert.ok(source.includes("maxLength={1000}"));
  assert.ok(source.includes("onStageChange(s, stageNote)"));
  assert.ok(source.includes("onWon(stageNote)"));
  assert.ok(source.includes("onLost(stageNote)"));
  assert.ok(source.includes('if (changed) setStageNote("")'));
});

test("stage mutation forwards notes without bypassing the owned stage endpoint", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  assert.ok(source.includes('updateStage = useCallback(async (stage: string, note = "")'));
  assert.ok(source.includes("JSON.stringify({ stage, note: note.trim() })"));
  assert.equal(source.includes('.from("leads").update({ stage'), false);
});


test("stage update and audit note commit atomically", async () => {
  const route = await read("src/app/api/leads/[id]/stage/route.ts");
  const migration = await read("supabase/migrations/20260714000003_atomic_stage_transition.sql");
  assert.match(route, /\.rpc\("transition_lead_stage"/);
  assert.doesNotMatch(route, /eventLogged: !eventError/);
  assert.match(migration, /UPDATE public\.leads[\s\S]*INSERT INTO public\.business_events/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /actor_role IS NULL/);
  assert.match(migration, /p_next_stage NOT IN/);
  assert.match(migration, /char_length\(clean_note\) > 1000/);
});

test("database RPC blocks skips, backwards moves, and terminal rollback", async () => {
  const migration = await read("supabase/migrations/20260714000003_atomic_stage_transition.sql");
  assert.match(migration, /current_lead\.stage IN \('won', 'lost'\)/);
  assert.match(migration, /allowed_next_stage := CASE current_lead\.stage/);
  assert.match(migration, /p_next_stage NOT IN \('won', 'lost'\)[\s\S]*p_next_stage IS DISTINCT FROM allowed_next_stage/);
  assert.match(migration, /ELSE NULL/);
});
