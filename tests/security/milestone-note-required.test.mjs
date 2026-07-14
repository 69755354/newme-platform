import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("milestone API rejects blank notes and persists the trimmed user note", async () => {
  const route = await read("src/app/api/leads/[id]/milestone/route.ts");
  assert.match(route, /const cleanNotes = String\(notes \?\? ""\)\.trim\(\)/);
  assert.match(route, /if \(!cleanNotes\)/);
  assert.match(route, /Milestone note is required/);
  assert.match(route, /notes: cleanNotes/);
});

test("sales UI requires a user-entered note for the next milestone", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(source, /const \[milestoneNote, setMilestoneNote\] = useState\(""/);
  assert.match(source, /Milestone note \(required\)/);
  assert.match(source, /milestoneNote\.trim\(\)/);
  assert.match(source, /onToggleMilestone\(key, false, milestoneNote\.trim\(\)\)/);
});

test("milestone mutation sends the user note without a generated template", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  assert.match(source, /toggleMilestone = useCallback\(async \(milestoneKey: string, currentlyCompleted: boolean, note = ""\)/);
  assert.match(source, /notes: note\.trim\(\)/);
  assert.doesNotMatch(source, /Manually completed milestone:/);
  assert.doesNotMatch(source, /手动完成里程碑:/);
});

test("database rejects blank manual milestone notes and derives First Contact note from its contact fact", async () => {
  const migration = await read("supabase/migrations/20260715000000_require_milestone_notes.sql");
  assert.match(migration, /BEFORE INSERT OR UPDATE OF notes ON public\.lead_milestones/);
  assert.match(migration, /NEW\.milestone_key IN \(/);
  for (const key of ["first_contact", "basic_info", "drawings", "requirements", "solution", "quotation", "meeting"]) {
    assert.ok(migration.includes(`'${key}'`), `missing milestone key ${key}`);
  }
  assert.match(migration, /FROM public\.follow_up_logs/);
  assert.match(migration, /Milestone note is required/);
});
